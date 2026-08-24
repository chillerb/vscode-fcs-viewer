import { ticks as niceTicks } from '../../common/ticks';
import { significant, siPrefix } from '../../common/format';
import {
	DEFAULT_LOG_M,
	DEFAULT_LOG_T,
	defined,
	forward,
	inverse,
	logRange,
	defaultLogParams,
	type LogParams,
	type TransformKind,
	type TransformSpec,
} from '../../common/fcs/transform';

export interface Tick {
	/** Position in transformed space. */
	value: number;
	label: string;
	major: boolean;
}

/**
 * A transform plus a domain, in the shape a d3 scale would have: callable,
 * invertible, with ticks() and tickFormat(). Kept because arsinh has no
 * built-in equivalent anywhere, and the tick thinning is what makes a
 * biexponential axis readable.
 */
export interface Scale {
	kind: TransformKind;
	spec: TransformSpec;
	/** Domain in RAW data units. */
	domain: [number, number];
	/** Domain in transformed units. */
	tDomain: [number, number];
	range: [number, number];
	/** Raw value to pixel. */
	(v: number): number;
	/** Transformed value to pixel. */
	project(t: number): number;
	/** Pixel back to raw value. */
	invert(px: number): number;
	defined(v: number): boolean;
	ticks(count?: number): number[];
	tickFormat(count?: number): (v: number) => string;
	copy(): Scale;
}

const compact = siPrefix;
const general = (v: number): string => significant(v, 6);

function labelFor(v: number): string {
	if (v === 0) {
		return '0';
	}
	// SI prefixes for everything above a thousand. The upper branch used to
	// stop at 1e6 and fall through to the same plain formatting as small
	// numbers, so one axis read "100k" while the next read "1,000,000".
	// Cytometry axes reach 1e6 routinely, so that was the common case.
	return Math.abs(v) >= 1000 ? compact(v) : general(v);
}

/**
 * Candidate ticks for a symmetric log-like axis: zero plus 1/2/5 x 10^k in
 * both directions. Thinned by pixel distance so a biexponential axis reads as
 * -10^2, 0, 10^2, 10^3, 10^4 rather than a smear near zero.
 */
function symmetricCandidates(): number[] {
	const out: number[] = [0];
	for (let k = -2; k <= 7; k++) {
		for (const m of [1, 2, 5]) {
			const v = m * Math.pow(10, k);
			out.push(v, -v);
		}
	}
	return out.sort((a, b) => a - b);
}

const SYMMETRIC = symmetricCandidates();
const MIN_TICK_GAP_PX = 52;

export function makeScale(
	kind: TransformKind,
	cofactor: number,
	domain: [number, number],
	range: [number, number],
	log: { m: number; t: number } = { m: DEFAULT_LOG_M, t: DEFAULT_LOG_T },
): Scale {
	const spec: TransformSpec = { kind, cofactor, logM: log.m, logT: log.t };
	let [d0, d1] = domain;
	if (!(Number.isFinite(d0) && Number.isFinite(d1)) || d0 === d1) {
		d0 = kind === 'log' ? 1 : 0;
		d1 = d0 + 1;
	}
	if (kind === 'log' && d0 <= 0) {
		d0 = Math.max(1e-3, d1 / 1e4);
	}

	const t0 = forward(d0, spec);
	const t1 = forward(d1, spec);
	const [r0, r1] = range;
	const span = t1 - t0 || 1;
	const pixels = Math.abs(r1 - r0) || 1;

	const project = (t: number): number => r0 + ((t - t0) / span) * (r1 - r0);

	const scale = ((v: number) => project(forward(v, spec))) as Scale;
	scale.kind = kind;
	scale.spec = spec;
	scale.domain = [d0, d1];
	scale.tDomain = [t0, t1];
	scale.range = range;
	scale.project = project;
	scale.invert = (px: number) => inverse(t0 + ((px - r0) / (r1 - r0)) * span, spec);
	scale.defined = (v: number) => defined(v, spec);

	scale.ticks = (count?: number): number[] => {
		const target = count ?? Math.max(2, Math.floor(pixels / 70));
		if (kind === 'linear') {
			return niceTicks(d0, d1, target);
		}
		if (kind === 'log') {
			const lo = Math.ceil(Math.log10(d0));
			const hi = Math.floor(Math.log10(d1));
			const decades: number[] = [];
			for (let k = lo; k <= hi; k++) {
				decades.push(Math.pow(10, k));
			}
			return decades.length >= 2 ? decades : niceTicks(d0, d1, target);
		}
		// arsinh: keep zero, then greedily drop candidates that would crowd.
		const kept: number[] = [];
		let lastPx = -Infinity;
		for (const v of SYMMETRIC) {
			if (v < d0 || v > d1) {
				continue;
			}
			const px = project(forward(v, spec));
			if (v !== 0 && Math.abs(px - lastPx) < MIN_TICK_GAP_PX) {
				continue;
			}
			kept.push(v);
			lastPx = px;
		}
		if (!kept.includes(0) && d0 <= 0 && d1 >= 0) {
			kept.push(0);
			kept.sort((a, b) => a - b);
		}
		return kept;
	};

	scale.tickFormat = () => labelFor;
	scale.copy = () => makeScale(kind, cofactor, [d0, d1], range, log);
	return scale;
}

/**
 * Auto domain from percentiles in transformed space, padded and widened to
 * include zero when the channel has negatives (otherwise an arsinh axis crops
 * the negative population invisibly).
 */
export function autoDomain(
	values: Float32Array,
	indices: Uint32Array,
	kind: TransformKind,
	cofactor: number,
	log: { m: number; t: number } = { m: DEFAULT_LOG_M, t: DEFAULT_LOG_T },
): [number, number] {
	// A log axis takes its range straight from the flog parameters, which is
	// the only way M and T have any visible effect: flog is affine in log10,
	// so on a percentile-derived range they would shift the values, the range
	// and the ticks together and leave the picture untouched. The parameters
	// themselves are seeded from the data, so 'auto' still frames the data.
	if (kind === 'log') {
		return logRange({ m: log.m, t: log.t });
	}
	const spec: TransformSpec = { kind, cofactor, logM: log.m, logT: log.t };
	const n = indices.length;
	if (n === 0) {
		return [0, 1];
	}
	const buf = new Float32Array(n);
	let m = 0;
	let hasNegative = false;
	for (let i = 0; i < n; i++) {
		const v = values[indices[i]!]!;
		if (!defined(v, spec)) {
			continue;
		}
		if (v < 0) {
			hasNegative = true;
		}
		buf[m++] = v;
	}
	if (m === 0) {
		return [0, 1];
	}
	const a = buf.subarray(0, m);
	a.sort();
	const at = (p: number): number => a[Math.min(m - 1, Math.max(0, Math.round((m - 1) * p)))]!;
	let lo = at(0.001);
	let hi = at(0.999);
	if (lo === hi) {
		hi = lo + Math.max(1, Math.abs(lo) * 0.1);
	}

	// Pad by 3% in transformed space so the extremes are not glued to the axis.
	const tLo = forward(lo, spec);
	const tHi = forward(hi, spec);
	const pad = (tHi - tLo) * 0.03;
	lo = inverse(tLo - pad, spec);
	hi = inverse(tHi + pad, spec);

	if (kind === 'arsinh' && hasNegative && lo > 0) {
		lo = 0;
	}
	return [lo, hi];
}

/**
 * flog parameters for a channel the user has not set them on.
 *
 * Derived from the values actually plotted rather than from the host-side
 * statistics, so a compensated axis is framed on compensated numbers. One pass
 * over the subsample, which is a few thousand values.
 */
export function logParamsFor(values: Float32Array, indices: Uint32Array): LogParams {
	let max = -Infinity;
	let minPositive = Infinity;
	for (let i = 0; i < indices.length; i++) {
		const v = values[indices[i]!]!;
		if (!Number.isFinite(v) || v <= 0) {
			continue;
		}
		if (v > max) {
			max = v;
		}
		if (v < minPositive) {
			minPositive = v;
		}
	}
	return defaultLogParams(max, minPositive);
}
