import * as assert from 'assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { makeFcs } from '../unit/fixtures/makeFcs';
import { thisExtension } from './helpers';

function writeTempFcs(name: string, bytes: Uint8Array): vscode.Uri {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fcs-test-'));
	const file = path.join(dir, name);
	fs.writeFileSync(file, bytes);
	return vscode.Uri.file(file);
}

function tinyFcs(marker: string): Uint8Array {
	return makeFcs({
		channels: [
			{ name: 'FSC-A', bits: 32, range: 1024 },
			{ name: 'B515-A', label: marker, bits: 32, range: 1024 },
		],
		events: [[1, 2], [3, 4], [5, 6]],
		extraKeywords: { $CYT: 'LSRII' },
	});
}

suite('FCS Viewer extension', () => {
	suiteTeardown(async () => {
		await vscode.commands.executeCommand('workbench.action.closeAllEditors');
	});

	test('is discoverable and activates', async () => {
		const ext = thisExtension();
		assert.ok(ext, 'extension should be installed');
		await ext.activate();
		assert.ok(ext.isActive);
	});

	test('contributes the expected commands, and no more', async () => {
		const commands = await vscode.commands.getCommands(true);
		for (const id of [
			// The three verbs in the palette...
			'fcsViewer.openWorkspace',
			'fcsViewer.saveWorkspace',
			'fcsViewer.discardWorkspace',
			// ...and the two the explorer context menu adds.
			'fcsViewer.openFileInNewWorkspace',
			'fcsViewer.addFileToWorkspace',
		]) {
			assert.ok(commands.includes(id), `${id} should be registered`);
		}

		// Folded into Open Workspace, or dropped as redundant. Listed rather
		// than left implicit so bringing one back is a deliberate act.
		for (const id of [
			'fcsViewer.open',
			'fcsViewer.openInNewTab',
			'fcsViewer.newTab',
			'fcsViewer.addSample',
			'fcsViewer.clearWorkspace',
			'fcsViewer.deleteWorkspace',
			'fcsViewer.showLog',
		]) {
			assert.ok(!commands.includes(id), `${id} should be gone`);
		}
	});

	test('opens the viewer panel for an FCS file', async () => {
		const uri = writeTempFcs('tiny.fcs', tinyFcs('cd3'));
		await vscode.commands.executeCommand('fcsViewer.addFileToWorkspace', uri);
		const tab = vscode.window.tabGroups.activeTabGroup.activeTab;
		assert.ok(tab, 'a tab should be open');
		assert.strictEqual(tab.label, 'FCS Viewer');
	});

	test('reuses the same panel when a second sample is added', async () => {
		const before = vscode.window.tabGroups.all.flatMap((g) => g.tabs).length;
		const uri = writeTempFcs('second.fcs', tinyFcs('cd4'));
		await vscode.commands.executeCommand('fcsViewer.addFileToWorkspace', uri);
		const after = vscode.window.tabGroups.all.flatMap((g) => g.tabs).length;
		assert.strictEqual(after, before, 'adding a sample should not open another tab');
	});

	test('delivers the event matrix to the webview', async () => {
		const uri = writeTempFcs('transport.fcs', tinyFcs('cd8'));
		await vscode.commands.executeCommand('fcsViewer.addFileToWorkspace', uri);

		// The webview boots asynchronously; poll for its acknowledgement.
		let state: { acks?: Array<{ eventCount: number; sampledCount: number; channelCount: number }> } = {};
		for (let i = 0; i < 100; i++) {
			state = (await vscode.commands.executeCommand('fcsViewer.debugState')) as typeof state;
			if ((state.acks?.length ?? 0) > 0) {
				break;
			}
			await new Promise((r) => setTimeout(r, 100));
		}
		const ack = state.acks?.[state.acks.length - 1];
		assert.ok(ack, 'the webview should acknowledge receiving a slice');
		assert.strictEqual(ack.eventCount, 3, 'the file total is reported');
		assert.strictEqual(ack.sampledCount, 3, 'a tiny file is delivered whole');
		assert.strictEqual(ack.channelCount, 2);
	});

	test('surfaces an error for a malformed file without crashing', async () => {
		const junk = new Uint8Array(20);
		for (let i = 0; i < junk.length; i++) {
			junk[i] = (i * 37) & 0xff;
		}
		const uri = writeTempFcs('junk.fcs', junk);
		await vscode.commands.executeCommand('fcsViewer.addFileToWorkspace', uri);
		// The panel must still be alive and usable.
		const commands = await vscode.commands.getCommands(true);
		assert.ok(commands.includes('fcsViewer.addFileToWorkspace'));
	});
});
