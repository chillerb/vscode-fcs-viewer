import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { clampWidth, INSPECTOR_LIMITS, SAMPLES_LIMITS } from '../../webview/state/layout';

describe('clampWidth', () => {
	it('passes a sensible width through, rounded', () => {
		assert.equal(clampWidth(312.4, SAMPLES_LIMITS), 312);
	});

	it('holds the sidebar between its own limits', () => {
		assert.equal(clampWidth(10, SAMPLES_LIMITS), SAMPLES_LIMITS.min);
		assert.equal(clampWidth(5000, SAMPLES_LIMITS), SAMPLES_LIMITS.max);
	});

	// The width is persisted and travels inside a saved workspace, so it can
	// arrive from a much wider window than the one showing it.
	it('leaves room for the content when the window is narrow', () => {
		assert.equal(clampWidth(500, SAMPLES_LIMITS, 600), 360);
		assert.equal(clampWidth(500, INSPECTOR_LIMITS, 700), 460);
	});

	it('never returns less than the minimum, however narrow the window', () => {
		assert.equal(clampWidth(400, SAMPLES_LIMITS, 100), SAMPLES_LIMITS.min);
	});

	it('falls back to the default for a value that is not a number', () => {
		assert.equal(clampWidth(NaN, INSPECTOR_LIMITS), INSPECTOR_LIMITS.default);
		assert.equal(clampWidth(undefined as unknown as number, SAMPLES_LIMITS), SAMPLES_LIMITS.default);
	});
});
