/**
 * Nice tick positions on a linear interval -- the one thing d3-array was
 * carried for.
 *
 * Same algorithm d3 uses: snap the raw step to the nearest 1, 2, 5 or 10 times
 * a power of ten, then walk the multiples of that step inside the domain. The
 * result is ticks a reader recognises (0, 25, 50) rather than the arbitrary
 * ones an even division produces (0, 23.4, 46.8).
 */

const E10 = Math.sqrt(50);
const E5 = Math.sqrt(10);
const E2 = Math.sqrt(2);

/** The step size a nice tick sequence over [start, stop] would use. */
export function tickStep(start: number, stop: number, count: number): number {
	const step = (stop - start) / Math.max(0, count);
	const power = Math.floor(Math.log10(step));
	const error = step / Math.pow(10, power);
	const factor = error >= E10 ? 10 : error >= E5 ? 5 : error >= E2 ? 2 : 1;
	return factor * Math.pow(10, power);
}

export function ticks(start: number, stop: number, count: number): number[] {
	if (!(Number.isFinite(start) && Number.isFinite(stop)) || count <= 0) {
		return [];
	}
	if (start === stop) {
		return [start];
	}
	const reversed = stop < start;
	const [lo, hi] = reversed ? [stop, start] : [start, stop];

	const step = tickStep(lo, hi, count);
	if (!Number.isFinite(step) || step <= 0) {
		return [];
	}

	// Multiples of the step rather than repeated addition: accumulating a
	// float step drifts, and a tick labelled 0.30000000000000004 is a bug the
	// reader sees.
	const first = Math.ceil(lo / step);
	const last = Math.floor(hi / step);
	const out: number[] = [];
	for (let i = first; i <= last; i++) {
		out.push(i * step);
	}
	return reversed ? out.reverse() : out;
}
