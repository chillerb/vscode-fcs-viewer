/**
 * Density colouring for dot plots.
 *
 * Works in TRANSFORMED DATA space on a fixed grid rather than in pixels: the
 * values are handed to Plotly, which owns the projection, and a
 * resolution-independent grid also means zooming does not recolour the points.
 */
const GRID = 256;
const BLUR_RADIUS = 3;
const BLUR_PASSES = 3;

function boxBlurRows(src: Float32Array, dst: Float32Array, w: number, h: number, r: number): void {
	const norm = 1 / (2 * r + 1);
	for (let y = 0; y < h; y++) {
		const row = y * w;
		let sum = 0;
		for (let i = -r; i <= r; i++) {
			sum += src[row + Math.min(w - 1, Math.max(0, i))]!;
		}
		for (let x = 0; x < w; x++) {
			dst[row + x] = sum * norm;
			sum += src[row + Math.min(w - 1, x + r + 1)]! - src[row + Math.min(w - 1, Math.max(0, x - r))]!;
		}
	}
}

function transpose(src: Float32Array, dst: Float32Array, w: number, h: number): void {
	for (let y = 0; y < h; y++) {
		for (let x = 0; x < w; x++) {
			dst[x * h + y] = src[y * w + x]!;
		}
	}
}

/**
 * Per-point density in [0,1]. A 2D histogram followed by three separable box
 * blurs, which approximate a Gaussian by the central limit theorem. Chosen
 * over per-point kNN, which needs a spatial index rebuilt on every change and
 * costs hundreds of milliseconds at these point counts.
 */
/** Min and max in one pass, without spreading a typed array into Math.min. */
function extent(v: Float64Array): [number, number] {
	let lo = Infinity;
	let hi = -Infinity;
	for (let i = 0; i < v.length; i++) {
		const x = v[i]!;
		if (x < lo) {
			lo = x;
		}
		if (x > hi) {
			hi = x;
		}
	}
	return lo <= hi ? [lo, hi] : [0, 1];
}

export function pointDensity(
	tx: Float64Array,
	ty: Float64Array,
	// Omit to measure the points themselves. Callers that already have an axis
	// domain pass it, so the colouring matches what the axis shows.
	xDomain?: [number, number],
	yDomain?: [number, number],
): Float64Array {
	const n = tx.length;
	const out = new Float64Array(n);
	if (n === 0) {
		return out;
	}

	const [x0, x1] = xDomain ?? extent(tx);
	const [y0, y1] = yDomain ?? extent(ty);
	const xSpan = x1 - x0 || 1;
	const ySpan = y1 - y0 || 1;

	const counts = new Float32Array(GRID * GRID);
	const cellOf = new Int32Array(n);
	for (let i = 0; i < n; i++) {
		const gx = Math.min(GRID - 1, Math.max(0, ((tx[i]! - x0) / xSpan) * GRID | 0));
		const gy = Math.min(GRID - 1, Math.max(0, ((ty[i]! - y0) / ySpan) * GRID | 0));
		const cell = gy * GRID + gx;
		cellOf[i] = cell;
		counts[cell]!++;
	}

	const a = counts;
	const b = new Float32Array(GRID * GRID);
	for (let pass = 0; pass < BLUR_PASSES; pass++) {
		boxBlurRows(a, b, GRID, GRID, BLUR_RADIUS);
		transpose(b, a, GRID, GRID);
		boxBlurRows(a, b, GRID, GRID, BLUR_RADIUS);
		transpose(b, a, GRID, GRID);
	}

	// Normalise against a high percentile of occupied cells rather than the
	// maximum: on mass cytometry data a large share of events sit at exactly
	// zero, and that one saturated bin would otherwise flatten the colormap.
	const occupied: number[] = [];
	for (let i = 0; i < GRID * GRID; i++) {
		if (a[i]! > 0) {
			occupied.push(a[i]!);
		}
	}
	occupied.sort((p, q) => p - q);
	const reference = occupied.length > 0
		? occupied[Math.min(occupied.length - 1, Math.floor(occupied.length * 0.995))]! || 1
		: 1;

	for (let i = 0; i < n; i++) {
		const d = a[cellOf[i]!]! / reference;
		// sqrt compresses the long tail so mid-density structure stays visible.
		out[i] = d <= 0 ? 0 : Math.min(1, Math.sqrt(d));
	}
	return out;
}
