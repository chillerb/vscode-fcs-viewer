import { warn, type FcsWarning } from './errors';
import type { FcsSpillover } from './types';

/**
 * Invert a spillover matrix by Gauss-Jordan elimination with partial pivoting.
 * Returns undefined if the matrix is singular. Matrices are 13x13-ish, so the
 * cubic cost is irrelevant.
 */
export function invertMatrix(m: Float64Array, size: number): Float64Array | undefined {
	const a = Float64Array.from(m);
	const inv = new Float64Array(size * size);
	for (let i = 0; i < size; i++) {
		inv[i * size + i] = 1;
	}

	for (let col = 0; col < size; col++) {
		let pivot = col;
		let best = Math.abs(a[col * size + col]!);
		for (let r = col + 1; r < size; r++) {
			const v = Math.abs(a[r * size + col]!);
			if (v > best) {
				best = v;
				pivot = r;
			}
		}
		if (best < 1e-12) {
			return undefined;
		}
		if (pivot !== col) {
			for (let k = 0; k < size; k++) {
				const t = a[col * size + k]!;
				a[col * size + k] = a[pivot * size + k]!;
				a[pivot * size + k] = t;
				const u = inv[col * size + k]!;
				inv[col * size + k] = inv[pivot * size + k]!;
				inv[pivot * size + k] = u;
			}
		}
		const d = a[col * size + col]!;
		for (let k = 0; k < size; k++) {
			a[col * size + k] = a[col * size + k]! / d;
			inv[col * size + k] = inv[col * size + k]! / d;
		}
		for (let r = 0; r < size; r++) {
			if (r === col) {
				continue;
			}
			const f = a[r * size + col]!;
			if (f === 0) {
				continue;
			}
			for (let k = 0; k < size; k++) {
				a[r * size + k] = a[r * size + k]! - f * a[col * size + k]!;
				inv[r * size + k] = inv[r * size + k]! - f * inv[col * size + k]!;
			}
		}
	}
	return inv;
}

export function invertSpillover(sp: FcsSpillover, warnings: FcsWarning[]): Float64Array | undefined {
	const inv = invertMatrix(sp.matrix, sp.size);
	if (inv === undefined) {
		warn(warnings, 'SPILLOVER_SINGULAR', `The ${sp.source} matrix is singular and cannot be inverted; compensation is unavailable.`, sp.source);
	}
	return inv;
}

/**
 * Apply compensation to the spillover subset of a column-major matrix.
 *
 * Two things this must get right:
 *  - Coverage is partial. data/001.fcs lists 13 of 22 channels in SPILL, so
 *    FSC/SSC/Time and the unused detectors pass through untouched.
 *  - Ordering. Compensation operates on raw linear values and must run BEFORE
 *    any axis transform; arsinh-then-compensate is silent garbage.
 *
 * Returns one Float32Array per spillover channel, parallel to sp.channelIndices.
 */
export function compensateColumns(
	matrix: Float32Array,
	eventCount: number,
	sp: FcsSpillover,
	inverse: Float64Array,
): Float32Array[] {
	const size = sp.size;
	const out: Float32Array[] = [];
	for (let i = 0; i < size; i++) {
		out.push(new Float32Array(eventCount));
	}
	const sources: Float32Array[] = sp.channelIndices.map((idx) =>
		matrix.subarray(idx * eventCount, (idx + 1) * eventCount),
	);

	// compensated = raw * inverse (row-vector convention): a dot product over
	// all `size` detectors per event, which is why this cannot be done one
	// column at a time.
	for (let j = 0; j < size; j++) {
		const dst = out[j]!;
		for (let i = 0; i < size; i++) {
			const coeff = inverse[i * size + j]!;
			if (coeff === 0) {
				continue;
			}
			const src = sources[i]!;
			for (let e = 0; e < eventCount; e++) {
				dst[e] = dst[e]! + coeff * src[e]!;
			}
		}
	}
	return out;
}
