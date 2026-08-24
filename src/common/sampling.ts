/** Small deterministic PRNG, so plots are reproducible across re-renders. */
export function mulberry32(seed: number): () => number {
	let a = seed >>> 0;
	return () => {
		a = (a + 0x6d2b79f5) >>> 0;
		let t = a;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

/**
 * Seeded Fisher-Yates over [0, n). Built once per sample; a prefix of it is
 * the subsample. Random rather than strided because FCS files are
 * time-ordered, so acquisition drift and start-of-run instability are
 * systematic in time and a stride can alias with periodic artefacts.
 */
export function buildPermutation(n: number, seed: number): Uint32Array {
	const p = new Uint32Array(n);
	for (let i = 0; i < n; i++) {
		p[i] = i;
	}
	const rand = mulberry32(seed);
	for (let i = n - 1; i > 0; i--) {
		const j = Math.floor(rand() * (i + 1));
		const t = p[i]!;
		p[i] = p[j]!;
		p[j] = t;
	}
	return p;
}

export interface GatheredSlice {
	/** Column-major over the sampled rows: values[c * count + i]. */
	values: Float32Array;
	/** Original event index of row i. */
	eventIds: Uint32Array;
	count: number;
}

/**
 * Copy `count` events out of a column-major matrix into a compact slice.
 *
 * Rows come out in PERMUTATION order, not sorted. That is what makes a prefix
 * of the result a smaller valid sample: taking rows 0..k-1 is exactly what
 * gathering k rows would have produced. Sorting here would break that, and
 * capping by slicing a sorted set would keep the lowest event indices -- the
 * start of a time-ordered acquisition -- which is the bias the permutation
 * exists to remove, and which is invisible on a plot.
 */
export function gatherSlice(
	matrix: Float32Array,
	eventCount: number,
	channelCount: number,
	permutation: Uint32Array,
	requested: number,
): GatheredSlice {
	const count = Math.max(0, Math.min(requested, eventCount));
	const values = new Float32Array(count * channelCount);
	const eventIds = new Uint32Array(count);
	for (let i = 0; i < count; i++) {
		eventIds[i] = permutation[i]!;
	}
	for (let c = 0; c < channelCount; c++) {
		const src = c * eventCount;
		const dst = c * count;
		for (let i = 0; i < count; i++) {
			values[dst + i] = matrix[src + eventIds[i]!]!;
		}
	}
	return { values, eventIds, count };
}
