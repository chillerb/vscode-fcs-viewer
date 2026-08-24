import * as assert from 'assert';
import * as vscode from 'vscode';
import { debugState, until } from './helpers';

// Gated: data/ is gitignored, so this only runs when pointed at a real file.
//   FCS_TEST_FILE=<abs path> xvfb-run -a npm test
const REAL = process.env['FCS_TEST_FILE'];

suite('FCS Viewer with a real file', function () {
	this.timeout(120_000);

	test('loads and transports a full-size sample', async function () {
		if (!REAL) {
			this.skip();
		}
		const started = Date.now();
		await vscode.commands.executeCommand('fcsViewer.addFileToWorkspace', vscode.Uri.file(REAL));

		await until('the webview to acknowledge the slice', async () => (await debugState()).acks.length > 0, 60_000);
		const elapsed = Date.now() - started;
		const state = await debugState();
		assert.ok(!state.samples.some((s) => s.error), `sample failed: ${state.samples[0]?.error}`);
		const ack = state.acks[state.acks.length - 1];
		assert.ok(ack, 'the webview should acknowledge the matrix');
		console.log(
			`      real file: ${ack.sampledCount} of ${ack.eventCount} events x ${ack.channelCount} ` +
			`delivered in ${elapsed}ms end to end`,
		);
		assert.ok(ack.eventCount > 1000, 'expected a full-size sample');
		// The regression guard for the whole subsample-transport change: a large
		// file must never ship every event just because it was opened.
		assert.ok(
			ack.sampledCount <= 10_000,
			`only the subsample should be transferred, got ${ack.sampledCount} rows`,
		);
		assert.ok(ack.sampledCount < ack.eventCount);
	});
});
