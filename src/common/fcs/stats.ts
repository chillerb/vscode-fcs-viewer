export interface ChannelStats {
	channel: number;
	/** Finite values only. */
	count: number;
	nonFinite: number;
	min: number;
	max: number;
	mean: number;
	/** Sample standard deviation. */
	std: number;
	zeroCount: number;
	negativeCount: number;
	/** Filled in by the quantile pass; NaN until then. */
	p1: number;
	p5: number;
	q1: number;
	median: number;
	q3: number;
	p95: number;
	p99: number;
}

export const QUANTILE_PROBS = [0.01, 0.05, 0.25, 0.5, 0.75, 0.95, 0.99] as const;

export function emptyStats(channel: number): ChannelStats {
	return {
		channel, count: 0, nonFinite: 0, min: NaN, max: NaN, mean: NaN, std: NaN,
		zeroCount: 0, negativeCount: 0,
		p1: NaN, p5: NaN, q1: NaN, median: NaN, q3: NaN, p95: NaN, p99: NaN,
	};
}

/**
 * Single pass over one column. Cheap enough to run while the data is still hot
 * in cache from parsing. Uses Welford so the variance stays stable on the wide
 * dynamic ranges cytometry produces.
 */
export function computeBasicStats(col: Float32Array, channel: number): ChannelStats {
	const s = emptyStats(channel);
	let min = Infinity;
	let max = -Infinity;
	let mean = 0;
	let m2 = 0;
	let n = 0;

	for (let i = 0; i < col.length; i++) {
		const v = col[i]!;
		if (!Number.isFinite(v)) {
			s.nonFinite++;
			continue;
		}
		if (v < min) { min = v; }
		if (v > max) { max = v; }
		if (v === 0) { s.zeroCount++; } else if (v < 0) { s.negativeCount++; }
		n++;
		const delta = v - mean;
		mean += delta / n;
		m2 += delta * (v - mean);
	}

	s.count = n;
	if (n > 0) {
		s.min = min;
		s.max = max;
		s.mean = mean;
		s.std = n > 1 ? Math.sqrt(m2 / (n - 1)) : 0;
	}
	return s;
}

/** In-place Floyd-Rivest style selection: partition so that a[k] is in place. */
function quickselect(a: Float32Array, k: number, left = 0, right = a.length - 1): number {
	while (right > left) {
		if (right - left > 600) {
			// Recurse on a narrowed window for large ranges (Floyd-Rivest).
			const n = right - left + 1;
			const i = k - left + 1;
			const z = Math.log(n);
			const s = 0.5 * Math.exp((2 * z) / 3);
			const sd = 0.5 * Math.sqrt((z * s * (n - s)) / n) * (i - n / 2 < 0 ? -1 : 1);
			const newLeft = Math.max(left, Math.floor(k - (i * s) / n + sd));
			const newRight = Math.min(right, Math.floor(k + ((n - i) * s) / n + sd));
			quickselect(a, k, newLeft, newRight);
		}
		const t = a[k]!;
		let i = left;
		let j = right;
		const tmp0 = a[left]!;
		a[left] = a[k]!;
		a[k] = tmp0;
		if (a[right]! > t) {
			const tmp = a[right]!;
			a[right] = a[left]!;
			a[left] = tmp;
		}
		while (i < j) {
			const tmp = a[i]!;
			a[i] = a[j]!;
			a[j] = tmp;
			i++;
			j--;
			while (a[i]! < t) { i++; }
			while (a[j]! > t) { j--; }
		}
		if (a[left]! === t) {
			const tmp = a[left]!;
			a[left] = a[j]!;
			a[j] = tmp;
		} else {
			j++;
			const tmp = a[j]!;
			a[j] = a[right]!;
			a[right] = tmp;
		}
		if (j <= k) { left = j + 1; }
		if (k <= j) { right = j - 1; }
	}
	return a[k]!;
}

/**
 * Quantiles by selection rather than a full sort: seven selects over 146k
 * floats is a few milliseconds, where sorting would be seconds.
 * Uses the R type-7 (linear interpolation) convention.
 */
export function computeQuantiles(
	col: Float32Array,
	probs: readonly number[],
	/** Reused across channels; allocating one per channel dominated the cost. */
	scratch?: Float32Array,
): number[] {
	const finite = scratch !== undefined && scratch.length >= col.length
		? scratch
		: new Float32Array(col.length);
	let n = 0;
	for (let i = 0; i < col.length; i++) {
		const v = col[i]!;
		if (Number.isFinite(v)) {
			finite[n++] = v;
		}
	}
	if (n === 0) {
		return probs.map(() => NaN);
	}
	const a = finite.subarray(0, n);

	// Every rank needed by every quantile, selected in ascending order on one
	// shared buffer. quickselect leaves everything below k to its left, so a
	// later, larger k is still correct without re-copying.
	const ranks = new Set<number>();
	for (const p of probs) {
		const h = (n - 1) * p;
		ranks.add(Math.floor(h));
		ranks.add(Math.ceil(h));
	}
	const ordered = [...ranks].sort((x, y) => x - y);
	const value = new Map<number, number>();
	for (const k of ordered) {
		value.set(k, quickselect(a, k));
	}

	return probs.map((p) => {
		const h = (n - 1) * p;
		const lo = Math.floor(h);
		const hi = Math.ceil(h);
		const vLo = value.get(lo)!;
		return lo === hi ? vLo : vLo + (h - lo) * (value.get(hi)! - vLo);
	});
}

export function fillQuantiles(stats: ChannelStats, col: Float32Array, scratch?: Float32Array): ChannelStats {
	const [p1, p5, q1, median, q3, p95, p99] = computeQuantiles(col, QUANTILE_PROBS, scratch);
	return { ...stats, p1: p1!, p5: p5!, q1: q1!, median: median!, q3: q3!, p95: p95!, p99: p99! };
}
