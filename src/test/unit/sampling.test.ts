import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildPermutation, gatherSlice, mulberry32 } from '../../common/sampling';

const EVENTS = 40_000;
const CHANNELS = 4;
const SEED = 0x5eed;

/** value = event * 10 + channel, in column-major layout. */
function matrix(): Float32Array {
	const m = new Float32Array(EVENTS * CHANNELS);
	for (let c = 0; c < CHANNELS; c++) {
		for (let e = 0; e < EVENTS; e++) {
			m[c * EVENTS + e] = e * 10 + c;
		}
	}
	return m;
}

function slice(n: number, seed = SEED) {
	return gatherSlice(matrix(), EVENTS, CHANNELS, buildPermutation(EVENTS, seed), n);
}

describe('mulberry32', () => {
	it('is deterministic for a seed', () => {
		const a = mulberry32(1);
		const b = mulberry32(1);
		for (let i = 0; i < 10; i++) {
			assert.equal(a(), b());
		}
	});
});

describe('buildPermutation', () => {
	it('is a permutation of every index', () => {
		const p = buildPermutation(1000, SEED);
		assert.equal(new Set(p).size, 1000);
		assert.equal(Math.min(...p), 0);
		assert.equal(Math.max(...p), 999);
	});

	it('is deterministic, so plots are reproducible across sessions', () => {
		assert.deepEqual(buildPermutation(500, SEED), buildPermutation(500, SEED));
	});
});

describe('gatherSlice', () => {
	it('copies the right values for every row and channel', () => {
		const m = matrix();
		const g = gatherSlice(m, EVENTS, CHANNELS, buildPermutation(EVENTS, SEED), 200);
		assert.equal(g.count, 200);
		for (let c = 0; c < CHANNELS; c++) {
			for (let i = 0; i < g.count; i++) {
				assert.equal(g.values[c * g.count + i], m[c * EVENTS + g.eventIds[i]!]);
			}
		}
	});

	/**
	 * The property everything downstream relies on: rows come out in
	 * permutation order, so a prefix is itself a valid, smaller subsample. That
	 * is what lets the webview shrink the subsample and apply the no-WebGL cap
	 * without a round-trip.
	 */
	it('nests: a smaller slice is a literal prefix of a larger one', () => {
		const small = slice(5_000);
		const large = slice(10_000);
		assert.deepEqual(
			Array.from(small.eventIds),
			Array.from(large.eventIds.subarray(0, 5_000)),
		);
	});

	/**
	 * The other half of the same coin, and the reason rows are NOT sorted.
	 * Gathering ascending would be marginally faster and would make a prefix
	 * keep only the lowest event indices -- the start of a time-ordered
	 * acquisition, where drift and instability live. That bias is invisible on
	 * a plot, so it needs a test rather than a comment.
	 */
	it('spans the whole acquisition rather than its start', () => {
		const ids = slice(5_000).eventIds;
		assert.ok(Math.max(...ids) > 0.85 * EVENTS, 'the sample should reach the end of the run');
		assert.ok(Math.min(...ids) < 0.15 * EVENTS, 'and the start of it');
	});

	it('is not the same as gathering the first n events', () => {
		const ids = slice(5_000).eventIds;
		assert.notDeepEqual(Array.from(ids), Array.from({ length: 5_000 }, (_, i) => i));
	});

	it('yields every event exactly once when asked for all', () => {
		const g = slice(EVENTS);
		assert.equal(g.count, EVENTS);
		assert.equal(new Set(g.eventIds).size, EVENTS);
	});

	it('clamps a request larger than the file', () => {
		assert.equal(slice(EVENTS * 2).count, EVENTS);
	});

	it('handles a zero-row request', () => {
		const g = slice(0);
		assert.equal(g.count, 0);
		assert.equal(g.values.length, 0);
	});

	it('gives different cells for a different seed', () => {
		assert.notDeepEqual(
			Array.from(slice(100).eventIds),
			Array.from(slice(100, 0x1234).eventIds),
		);
	});
});
