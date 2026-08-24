import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { budgetRows, bytesPerEvent, decideSlice } from '../../extension/sliceBudget';

/**
 * These are the numbers that decide whether a remote connection stalls, and
 * until this module was extracted the only way to reach them was through a
 * live VS Code host and a real webview.
 */
const MB = 1024 * 1024;

describe('bytesPerEvent', () => {
	it('counts the event id alongside the channel values', () => {
		assert.equal(bytesPerEvent(56), 56 * 4 + 4);
		assert.equal(bytesPerEvent(0), 4);
	});
});

describe('budgetRows', () => {
	it('fits the byte ceiling for a wide mass-cytometry file', () => {
		const rows = budgetRows(56, 16 * MB);
		assert.ok(rows * bytesPerEvent(56) <= 16 * MB);
		// And is not needlessly conservative: one more row would not fit.
		assert.ok((rows + 1) * bytesPerEvent(56) > 16 * MB);
	});

	it('never drops below a useful number of events', () => {
		// A pathological channel count would otherwise compute a budget of a
		// handful of cells, which makes for a useless plot.
		assert.equal(budgetRows(100_000, 1 * MB), 1000);
	});
});

describe('decideSlice', () => {
	const base = { eventCount: 146_215, channelCount: 56, maxBytes: 16 * MB, confirmed: false };

	it('passes a request that fits through untouched', () => {
		assert.deepEqual(decideSlice({ ...base, requested: 5000 }), { rows: 5000, clamped: false });
	});

	it('clamps an unconfirmed request that does not fit, and says so', () => {
		const d = decideSlice({ ...base, requested: null });
		assert.equal(d.clamped, true);
		assert.equal(d.rows, budgetRows(56, 16 * MB));
	});

	it('honours "all events" once the user has confirmed the cost', () => {
		const d = decideSlice({ ...base, requested: null, confirmed: true });
		assert.deepEqual(d, { rows: null, clamped: false });
	});

	it('treats null as the whole file when checking the budget', () => {
		// A small file asking for everything is under budget and must not be
		// clamped just because the request was open-ended.
		const d = decideSlice({ ...base, eventCount: 500, requested: null });
		assert.deepEqual(d, { rows: null, clamped: false });
	});

	it('does not clamp a confirmed oversized explicit count', () => {
		const d = decideSlice({ ...base, requested: 100_000, confirmed: true });
		assert.deepEqual(d, { rows: 100_000, clamped: false });
	});
});
