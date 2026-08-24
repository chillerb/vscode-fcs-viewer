import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { coerce, PERSISTED_VERSION, type PersistedState } from '../../webview/state/persistedState';
import type { CardConfig } from '../../webview/state/appReducer';
import { INSPECTOR_LIMITS, SAMPLES_LIMITS } from '../../webview/state/layout';

/**
 * The webview's own restore is not inside a try/catch -- a throw there blanks
 * the panel with nothing said -- so this is the layer that has to refuse bad
 * input rather than pass it on.
 */

const axis = { channel: { name: 'FSC-A', index: 0 }, transform: 'linear' as const, cofactor: 150 };

function scatter(id: string): CardConfig {
	return {
		id, kind: 'scatter', span: { cols: 1, rows: 1 }, x: axis, y: axis,
		colorBy: 'density', colormap: 'viridis', pointSize: 2,
	} as unknown as CardConfig;
}

function saved(cards: unknown[], version = PERSISTED_VERSION): PersistedState {
	return { version, cards: cards as CardConfig[] };
}

describe('coerce', () => {
	it('keeps well-formed cards', () => {
		assert.equal(coerce(saved([scatter('a'), scatter('b')]))?.cards?.length, 2);
	});

	// N3's downgrade path in miniature: a card of a kind this reader does not
	// understand, or one missing the field its renderer indexes into.
	it('drops cards it cannot read rather than throwing', () => {
		const patch = coerce(saved([
			scatter('good'),
			{ id: 'no-kind', span: { cols: 1, rows: 1 } },
			{ id: 'umap-without-channels', kind: 'umap' },
			{ id: 'scatter-without-y', kind: 'scatter', x: axis },
			{ id: 'axis-without-channel', kind: 'histogram', x: { transform: 'linear' } },
			null,
			'not a card',
		]));
		assert.deepEqual(patch?.cards?.map((c) => c.id), ['good']);
	});

	it('accepts a UMAP card, which has no axes', () => {
		const umap = { id: 'u', kind: 'umap', channels: [], span: { cols: 1, rows: 1 } };
		assert.deepEqual(coerce(saved([umap]))?.cards?.map((c) => c.id), ['u']);
	});

	// The version range is what lets an older build decline a blob written by
	// a newer one. It only works if the stamp moves when the shape widens.
	it('refuses a blob from a newer build', () => {
		assert.equal(coerce(saved([scatter('a')], PERSISTED_VERSION + 1)), undefined);
	});

	it('refuses a blob with no cards array or no version', () => {
		assert.equal(coerce({ version: PERSISTED_VERSION } as PersistedState), undefined);
		assert.equal(coerce({ cards: [] } as unknown as PersistedState), undefined);
		assert.equal(coerce(undefined), undefined);
	});
});

describe('coerce: sidebar widths', () => {
	const withLayout = (layout: unknown): PersistedState =>
		({ ...saved([scatter('a')]), layout } as PersistedState);

	it('restores widths that are in range', () => {
		const patch = coerce(withLayout({ samplesWidth: 320, inspectorWidth: 300 }));
		assert.deepEqual(patch?.layout, { samplesWidth: 320, inspectorWidth: 300 });
	});

	// A width saved on a wide monitor must not come back and swallow a narrow
	// window, and the blob travels between machines inside a workspace.
	it('clamps a width from a much larger window', () => {
		const patch = coerce(withLayout({ samplesWidth: 4000, inspectorWidth: -20 }));
		assert.deepEqual(patch?.layout, {
			samplesWidth: SAMPLES_LIMITS.max,
			inspectorWidth: INSPECTOR_LIMITS.min,
		});
	});

	it('falls back to the defaults for a corrupt value', () => {
		const patch = coerce(withLayout({ samplesWidth: 'wide', inspectorWidth: null }));
		assert.deepEqual(patch?.layout, {
			samplesWidth: SAMPLES_LIMITS.default,
			inspectorWidth: INSPECTOR_LIMITS.default,
		});
	});

	it('leaves the state alone when nothing was saved', () => {
		assert.equal(coerce(saved([scatter('a')]))?.layout, undefined);
	});
});
