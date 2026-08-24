import type { FcsMetadata } from './types';

export type TransformKind = 'linear' | 'log' | 'arsinh';

export interface TransformSpec {
	kind: TransformKind;
	/** Only meaningful for arsinh. */
	cofactor: number;
	/** flog decades; only meaningful for log. */
	logM?: number;
	/** flog top of scale; only meaningful for log. */
	logT?: number;
}

/**
 * GatingML 2.0 flog parameters. M is the number of decades, T the top of scale.
 * The spec's own defaults are both 1, which reduces flog to log10(x) + 1.
 *
 * Those defaults are deliberately NOT used as the UI defaults. flog is an
 * affine map of log10, so on a data-derived axis a change of M or T shifts the
 * values, the range and the tick positions by exactly the same amount and the
 * picture never moves -- the parameters look broken because they are inert.
 * They earn their keep only when they define the visible range, which is what
 * GatingML intends: flog maps [T*10^-M, T] onto [0, 1]. So the axis follows
 * the spec framing and M and T are seeded from the channel instead, by
 * defaultLogParams.
 */
export const DEFAULT_LOG_M = 1;
export const DEFAULT_LOG_T = 1;

export interface LogParams {
	/** Decades shown below the top of scale. */
	m: number;
	/** Top of scale, in raw data units. */
	t: number;
}

/**
 * flog parameters for a channel that has not been given explicit ones.
 *
 * T is the next power of ten at or above the largest value, so the data sits
 * just inside the top of the axis. M is the number of decades from there down
 * to the smallest positive value worth showing, clamped to a range that stays
 * readable: below one decade a log axis is pointless, and beyond six the
 * populations collapse into the top edge.
 */
export function defaultLogParams(max: number, minPositive: number): LogParams {
	const top = Number.isFinite(max) && max > 0 ? Math.pow(10, Math.ceil(Math.log10(max))) : 10;
	const floor = Number.isFinite(minPositive) && minPositive > 0 ? minPositive : top / 1e4;
	const decades = Math.ceil(Math.log10(top) - Math.log10(floor));
	return { m: Math.min(6, Math.max(1, Number.isFinite(decades) ? decades : 4)), t: top };
}

/** The visible range of a flog axis: flog maps exactly this onto [0, 1]. */
export function logRange(p: LogParams): [number, number] {
	return [p.t * Math.pow(10, -p.m), p.t];
}

export const DEFAULT_MASS_COFACTOR = 5;
export const DEFAULT_FLUORESCENCE_COFACTOR = 150;

/**
 * All three transforms are monotone increasing, which is what lets raw-scale
 * quantiles stay valid under any transform chosen later in the UI.
 */
export function forward(v: number, t: TransformSpec): number {
	switch (t.kind) {
		case 'linear':
			return v;
		case 'log':
			// GatingML 2.0 flog(x, M, T) = (1/M) * log10(x / T) + 1.
			return (1 / (t.logM ?? DEFAULT_LOG_M)) * Math.log10(v / (t.logT ?? DEFAULT_LOG_T)) + 1;
		case 'arsinh':
			// Math.asinh is accurate near zero; log(u + sqrt(u*u + 1)) is not,
			// and near-zero is exactly the regime that matters for cytometry.
			return Math.asinh(v / t.cofactor);
	}
}

export function inverse(t: number, spec: TransformSpec): number {
	switch (spec.kind) {
		case 'linear':
			return t;
		case 'log':
			return (spec.logT ?? DEFAULT_LOG_T) * Math.pow(10, (spec.logM ?? DEFAULT_LOG_M) * (t - 1));
		case 'arsinh':
			return spec.cofactor * Math.sinh(t);
	}
}

/**
 * Whether a value can be represented at all. Log excludes non-positive values
 * rather than clamping them: clamping piles every negative event onto the axis
 * edge, producing a solid bar that reads as a real population.
 */
export function defined(v: number, t: TransformSpec): boolean {
	if (!Number.isFinite(v)) {
		return false;
	}
	return t.kind === 'log' ? v > 0 : true;
}

export function transformColumn(src: Float32Array, dst: Float32Array, t: TransformSpec): void {
	const n = src.length;
	switch (t.kind) {
		case 'linear':
			dst.set(src.subarray(0, n));
			return;
		case 'log': {
			const m = t.logM ?? DEFAULT_LOG_M;
			const top = t.logT ?? DEFAULT_LOG_T;
			for (let i = 0; i < n; i++) {
				const v = src[i]!;
				dst[i] = v > 0 ? (1 / m) * Math.log10(v / top) + 1 : NaN;
			}
			return;
		}
		case 'arsinh': {
			const c = t.cofactor;
			for (let i = 0; i < n; i++) {
				dst[i] = Math.asinh(src[i]! / c);
			}
			return;
		}
	}
}

/**
 * Mass cytometry counts want a cofactor around 5; fluorescence wants ~150.
 * $CYT is the reliable signal, with the presence of a spillover matrix as a
 * fallback hint (mass cytometry has none).
 */
export function defaultCofactorFor(meta: FcsMetadata): number {
	const cyt = (meta.cytometer ?? '').toLowerCase();
	if (/helios|cytof|fluidigm|standard\s*biotools|xt/.test(cyt)) {
		return DEFAULT_MASS_COFACTOR;
	}
	if (meta.spillover !== undefined) {
		return DEFAULT_FLUORESCENCE_COFACTOR;
	}
	const allLinearFloat = meta.dataType === 'F' && meta.channels.every((c) => c.amplification === 'linear');
	return allLinearFloat ? DEFAULT_MASS_COFACTOR : DEFAULT_FLUORESCENCE_COFACTOR;
}
