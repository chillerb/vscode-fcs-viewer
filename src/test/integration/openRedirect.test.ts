import * as assert from 'assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { makeFcs } from '../unit/fixtures/makeFcs';
import { thisExtension, until } from './helpers';

const REDIRECT_VIEW_TYPE = 'fcsViewer.fileRedirect';
const WORKSPACE_VIEW_TYPE = 'fcsViewer.workspace';

interface DebugState {
	panelCount: number;
	samples: Array<{ id: string; fileName: string; error?: string }>;
	panels: Array<{ panelId: string; samples: Array<{ id: string; fileName: string }> }>;
}

function debugState(): Thenable<DebugState> {
	return vscode.commands.executeCommand('fcsViewer.debugState') as Thenable<DebugState>;
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

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fcs-redirect-'));
function writeFcs(name: string, marker = 'cd3'): vscode.Uri {
	const file = path.join(tmp, name);
	fs.writeFileSync(file, tinyFcs(marker));
	return vscode.Uri.file(file);
}

function allTabs(): vscode.Tab[] {
	return vscode.window.tabGroups.all.flatMap((g) => g.tabs);
}

function redirectTabs(): vscode.Tab[] {
	return allTabs().filter((t) => t.input instanceof vscode.TabInputCustom && t.input.viewType === REDIRECT_VIEW_TYPE);
}

function viewerTabs(): vscode.Tab[] {
	return allTabs().filter((t) => t.input instanceof vscode.TabInputWebview && t.input.viewType.endsWith(WORKSPACE_VIEW_TYPE));
}

function textTabsFor(uri: vscode.Uri): vscode.Tab[] {
	return allTabs().filter((t) => t.input instanceof vscode.TabInputText && t.input.uri.toString() === uri.toString());
}

/** Tab closing is asynchronous and not awaitable, so every check must poll. */
suite('Opening .fcs files', function () {
	this.timeout(60_000);

	setup(async () => {
		// Panels and workspaceState now outlive individual tests and even whole
		// runs (the .vscode-test user-data dir is reused), so without this the
		// count assertions below fail on stragglers.
		await vscode.commands.executeCommand('fcsViewer.debugReset');
		await vscode.commands.executeCommand('workbench.action.closeAllEditors');
	});

	suiteTeardown(async () => {
		await vscode.commands.executeCommand('fcsViewer.debugReset');
		await vscode.commands.executeCommand('workbench.action.closeAllEditors');
	});

	test('double-clicking a .fcs opens the viewer and leaves no editor tab', async () => {
		const uri = writeFcs('double-click.fcs');
		await vscode.commands.executeCommand('vscode.open', uri);

		await until('the sample to load', async () => (await debugState()).samples.length === 1);
		await until('the placeholder tab to close', () => redirectTabs().length === 0);

		assert.strictEqual(textTabsFor(uri).length, 0, 'the file must never open as text');
		assert.strictEqual(viewerTabs().length, 1);
		assert.strictEqual((await debugState()).samples[0]!.fileName, 'double-click.fcs');
	});

	test('the redirect viewType is exactly what the provider matches on', async () => {
		// If VS Code ever changes this string the tab matcher stops working and
		// orphan tabs accumulate silently, so pin it here.
		const uri = writeFcs('viewtype.fcs');
		let seen: string | undefined;
		const sub = vscode.window.tabGroups.onDidChangeTabs(() => {
			for (const tab of allTabs()) {
				if (tab.input instanceof vscode.TabInputCustom && tab.input.uri.toString() === uri.toString()) {
					seen ??= tab.input.viewType;
				}
			}
		});
		try {
			await vscode.commands.executeCommand('vscode.open', uri);
			await until('the sample to load', async () => (await debugState()).samples.length === 1);
		} finally {
			sub.dispose();
		}
		assert.strictEqual(seen, REDIRECT_VIEW_TYPE);
	});

	test('opening three files gives three samples in one tab', async () => {
		for (const name of ['one.fcs', 'two.fcs', 'three.fcs']) {
			await vscode.commands.executeCommand('vscode.open', writeFcs(name));
		}
		await until('all three samples', async () => (await debugState()).samples.length === 3);
		await until('placeholder tabs to close', () => redirectTabs().length === 0);

		const state = await debugState();
		assert.deepStrictEqual(state.samples.map((s) => s.id), ['s1', 's2', 's3']);
		assert.deepStrictEqual(state.samples.map((s) => s.fileName), ['one.fcs', 'two.fcs', 'three.fcs']);
		assert.strictEqual(viewerTabs().length, 1, 'all three should share one viewer tab');
	});

	test('opening the same file twice adds it once', async () => {
		const uri = writeFcs('twice.fcs');
		await vscode.commands.executeCommand('vscode.open', uri);
		await until('the sample to load', async () => (await debugState()).samples.length === 1);
		await vscode.commands.executeCommand('vscode.open', uri);
		await until('placeholder tabs to close', () => redirectTabs().length === 0);

		assert.strictEqual((await debugState()).samples.length, 1);
		assert.strictEqual(viewerTabs().length, 1);
	});

	test('Open With → Text Editor still works and is left alone', async () => {
		const uri = writeFcs('as-text.fcs');
		await vscode.commands.executeCommand('vscode.openWith', uri, 'default');
		await until('a text tab', () => textTabsFor(uri).length === 1);

		// Give the provider a chance to misbehave before asserting it did not.
		await new Promise((r) => setTimeout(r, 1000));
		assert.strictEqual(textTabsFor(uri).length, 1, 'the text editor must not be closed');
		assert.strictEqual((await debugState()).samples.length, 0, 'no sample should be added');
	});

	test('Open in New FCS Viewer Tab makes an independent tab', async () => {
		await vscode.commands.executeCommand('fcsViewer.addFileToWorkspace', writeFcs('first.fcs'));
		await until('the first sample', async () => (await debugState()).samples.length === 1);

		await vscode.commands.executeCommand('fcsViewer.openFileInNewWorkspace', writeFcs('second.fcs'));
		await until('a second panel', async () => (await debugState()).panelCount === 2);

		const state = await debugState();
		assert.strictEqual(viewerTabs().length, 2);
		const perPanel = state.panels.map((p) => p.samples.map((s) => s.fileName));
		assert.deepStrictEqual(perPanel.sort(), [['first.fcs'], ['second.fcs']].sort());
	});

	test('a multi-selection opens every file', async () => {
		const a = writeFcs('multi-a.fcs');
		const b = writeFcs('multi-b.fcs');
		await vscode.commands.executeCommand('fcsViewer.addFileToWorkspace', a, [a, b]);
		await until('both samples', async () => (await debugState()).samples.length === 2);
		assert.strictEqual(viewerTabs().length, 1);
	});
});

suite('Manifest', () => {
	test('declares the activation event the serializer needs', () => {
		// A test host cannot reload the window, so this manifest assertion is
		// the only automated guard against the array being emptied again.
		const ext = thisExtension();
		assert.ok(ext);
		const pkg = ext.packageJSON as {
			activationEvents: string[];
			contributes: { customEditors: Array<{ viewType: string; priority: string }> };
		};
		assert.ok(
			pkg.activationEvents.includes(`onWebviewPanel:${WORKSPACE_VIEW_TYPE}`),
			'without this the extension never activates to restore a panel',
		);
		const editor = pkg.contributes.customEditors[0]!;
		assert.strictEqual(editor.viewType, REDIRECT_VIEW_TYPE);
		assert.strictEqual(editor.priority, 'default', 'option priority would leave the text editor as default');
	});
});
