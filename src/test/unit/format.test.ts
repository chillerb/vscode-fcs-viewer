import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { fixed2, integer, significant, siPrefix } from '../../common/format';
import { tickStep, ticks } from '../../common/ticks';

/**
 * These replaced d3-format and d3-array. The point of the tests is that they
 * still behave the way the call sites were written against -- a table column
 * that stops aligning, or an axis whose labels drift, is the kind of change
 * nobody notices until a figure is already in a paper.
 */
describe('fixed2', () => {
	it('always shows exactly two decimals', () => {
		assert.equal(fixed2(0), '0.00');
		assert.equal(fixed2(-157.5), '-157.50');
		assert.equal(fixed2(1.005), '1.00');
	});

	it('groups the integer part', () => {
		assert.equal(fixed2(30787), '30,787.00');
		assert.equal(fixed2(-1234567.891), '-1,234,567.89');
	});

	it('collapses a value below half a hundredth, which is the known cost', () => {
		assert.equal(fixed2(0.004), '0.00');
	});
});

describe('integer', () => {
	it('rounds and groups', () => {
		assert.equal(integer(146215), '146,215');
		assert.equal(integer(999.6), '1,000');
		assert.equal(integer(-1500), '-1,500');
	});
});

describe('significant', () => {
	it('keeps the requested significant digits and trims trailing zeros', () => {
		assert.equal(significant(1.5000, 4), '1.5');
		assert.equal(significant(123.456, 4), '123.5');
		assert.equal(significant(0.00012345, 4), '0.0001234');
	});

	it('groups large values rather than flipping to exponential too early', () => {
		// The V1 bug: ',.4~g' rendered 49950 as 4.995e+4 next to a plain 30,787.
		assert.equal(significant(49950, 4), '49,950');
		assert.equal(significant(146215, 4), '146,215');
	});

	it('uses exponential at the extremes', () => {
		assert.equal(significant(0.0000123, 4), '1.23e-5');
		assert.equal(significant(1.5e9, 4), '1.5e+9');
	});

	it('reports non-finite values rather than throwing', () => {
		assert.equal(significant(NaN), 'NaN');
		assert.equal(significant(Infinity), '∞');
		assert.equal(significant(0), '0');
	});
});

describe('siPrefix', () => {
	it('matches the axis labels d3 produced', () => {
		assert.equal(siPrefix(1000), '1k');
		assert.equal(siPrefix(1500), '1.5k');
		assert.equal(siPrefix(2e6), '2M');
		assert.equal(siPrefix(-3400), '-3.4k');
	});
});

describe('ticks', () => {
	it('produces the 1/2/5 sequence d3 does', () => {
		assert.deepEqual(ticks(0, 10, 5), [0, 2, 4, 6, 8, 10]);
		assert.deepEqual(ticks(0, 1, 5), [0, 0.2, 0.4, 0.6000000000000001, 0.8, 1]);
		// 25 is not a 1/2/5 mantissa, so a request for 4 ticks snaps to 20.
		assert.deepEqual(ticks(0, 100, 4), [0, 20, 40, 60, 80, 100]);
	});

	it('handles a reversed domain', () => {
		assert.deepEqual(ticks(10, 0, 5), [10, 8, 6, 4, 2, 0]);
	});

	it('is safe on degenerate input', () => {
		assert.deepEqual(ticks(5, 5, 5), [5]);
		assert.deepEqual(ticks(0, NaN, 5), []);
		assert.deepEqual(ticks(0, 10, 0), []);
	});

	it('snaps the step to a power of ten times 1, 2 or 5', () => {
		for (const step of [tickStep(0, 10, 5), tickStep(0, 1000, 7), tickStep(0, 0.03, 4)]) {
			const mantissa = step / Math.pow(10, Math.floor(Math.log10(step)));
			assert.ok([1, 2, 5, 10].some((m) => Math.abs(mantissa - m) < 1e-9), `unexpected step ${step}`);
		}
	});
});
