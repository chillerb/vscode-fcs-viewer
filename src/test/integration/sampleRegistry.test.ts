import * as assert from 'assert';
import * as vscode from 'vscode';
import { MatrixCache } from '../../extension/matrixCache';
import { SampleRegistry } from '../../extension/sampleRegistry';
import type { PersistedSample } from '../../extension/workspaceStore';

// SampleRegistry imports vscode for Uri.parse, so this runs in the extension
// host rather than under node:test. adopt() itself does no I/O.

function sample(id: string, name: string): PersistedSample {
	return { id, uri: `file:///data/${name}`, fileName: name, eventCount: 1000, channelCount: 12, cytometer: 'LSRII' };
}

suite('SampleRegistry.adopt', () => {
	test('registers persisted samples without touching disk', () => {
		const r = new SampleRegistry(new MatrixCache());
		r.adopt(sample('s1', 'a.fcs'));
		r.adopt(sample('s2', 'b.fcs'));
		assert.deepStrictEqual(r.ids, ['s1', 's2']);
		assert.strictEqual(r.summaries[0]!.eventCount, 1000);
		assert.strictEqual(r.summaries[1]!.cytometer, 'LSRII');
	});

	test('preserves ids verbatim and never mints a colliding one', async () => {
		const r = new SampleRegistry(new MatrixCache());
		r.adopt(sample('s7', 'a.fcs'));
		assert.strictEqual(r.summaries[0]!.id, 's7');
		// add() parses, and this URI does not exist, but the id is minted
		// before the read -- which is exactly the collision being guarded.
		await r.add(vscode.Uri.parse('file:///data/new.fcs')).catch(() => undefined);
		const minted = r.ids.find((id) => id !== 's7');
		assert.ok(minted, 'a new id should have been minted');
		assert.notStrictEqual(minted, 's7', 'minted id must not collide with the adopted one');
		assert.strictEqual(minted, 's8');
	});

	test('deduplicates by uri', () => {
		const r = new SampleRegistry(new MatrixCache());
		assert.strictEqual(r.adopt(sample('s1', 'a.fcs')), r.adopt(sample('s2', 'a.fcs')));
		assert.strictEqual(r.ids.length, 1);
	});

	test('carries an error through to the summary', () => {
		const r = new SampleRegistry(new MatrixCache());
		r.adopt(sample('s1', 'gone.fcs'), 'File not found');
		assert.strictEqual(r.summaries[0]!.error, 'File not found');
	});

	test('round-trips through toPersisted', () => {
		const r = new SampleRegistry(new MatrixCache());
		r.adopt(sample('s1', 'a.fcs'));
		assert.deepStrictEqual(r.toPersisted(), [sample('s1', 'a.fcs')]);
	});

	test('drops removed samples from the persisted shape', () => {
		const r = new SampleRegistry(new MatrixCache());
		r.adopt(sample('s1', 'a.fcs'));
		r.adopt(sample('s2', 'b.fcs'));
		r.remove('s1');
		assert.deepStrictEqual(r.toPersisted().map((p) => p.id), ['s2']);
	});
});
