import * as assert from 'assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { makeFcs } from '../unit/fixtures/makeFcs';
import { until } from './helpers';

interface DebugState {
	panelCount: number;
	panels: Array<{
		panelId: string;
		activeId?: string;
		samples: Array<{ id: string; fileName: string }>;
		postedWorkspaceName?: string;
	}>;
}

interface Listed {
	name: string;
	samples: string[];
	activeId?: string;
	hasUi: boolean;
}

function debugState(): Thenable<DebugState> {
	return vscode.commands.executeCommand('fcsViewer.debugState') as Thenable<DebugState>;
}

function workspace<T>(action: 'save' | 'open' | 'delete' | 'list', name?: string): Thenable<T> {
	return vscode.commands.executeCommand('fcsViewer.debugWorkspace', action, name) as Thenable<T>;
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fcs-named-'));
function writeFcs(name: string): vscode.Uri {
	const file = path.join(tmp, name);
	fs.writeFileSync(file, makeFcs({
		channels: [
			{ name: 'FSC-A', bits: 32, range: 1024 },
			{ name: 'B515-A', label: 'cd3', bits: 32, range: 1024 },
		],
		events: [[1, 2], [3, 4], [5, 6]],
	}));
	return vscode.Uri.file(file);
}

suite('Named viewer workspaces', function () {
	this.timeout(60_000);

	setup(async () => {
		await vscode.commands.executeCommand('fcsViewer.debugReset');
		for (const w of await workspace<Listed[]>('list')) {
			await workspace('delete', w.name);
		}
		await vscode.commands.executeCommand('workbench.action.closeAllEditors');
	});

	suiteTeardown(async () => {
		await vscode.commands.executeCommand('fcsViewer.debugReset');
		for (const w of await workspace<Listed[]>('list')) {
			await workspace('delete', w.name);
		}
		await vscode.commands.executeCommand('workbench.action.closeAllEditors');
	});

	test('saves the samples of the focused tab and reopens them in a new one', async () => {
		await vscode.commands.executeCommand('fcsViewer.addFileToWorkspace', writeFcs('w-one.fcs'));
		await until('the first sample', async () => (await debugState()).panels[0]?.samples.length === 1);
		await vscode.commands.executeCommand('fcsViewer.addFileToWorkspace', writeFcs('w-two.fcs'));
		await until('both samples active', async () => {
			const p = (await debugState()).panels[0];
			return p?.samples.length === 2 && p.activeId === 's2';
		});

		assert.strictEqual(await workspace<string>('save', 'Panel A'), 'Panel A');
		const listed = await workspace<Listed[]>('list');
		assert.deepStrictEqual(listed.map((w) => w.name), ['Panel A']);
		assert.deepStrictEqual(listed[0]!.samples, ['w-one.fcs', 'w-two.fcs']);
		assert.strictEqual(listed[0]!.activeId, 's2');

		// A reopened workspace must not disturb the tab it was saved from: the
		// samples and the layout arrive as a set, into a tab of their own.
		const before = (await debugState()).panels[0]!.panelId;
		const opened = await workspace<string>('open', 'Panel A');
		assert.ok(opened && opened !== before, 'opens a new tab');

		await until('the reopened tab to adopt both samples', async () => {
			const p = (await debugState()).panels.find((x) => x.panelId === opened);
			return p?.samples.length === 2;
		});
		const restored = (await debugState()).panels.find((p) => p.panelId === opened)!;
		assert.deepStrictEqual(restored.samples.map((s) => s.fileName), ['w-one.fcs', 'w-two.fcs']);
		await until('the saved active sample to be selected', async () => {
			return (await debugState()).panels.find((p) => p.panelId === opened)?.activeId === 's2';
		});
		assert.strictEqual((await debugState()).panelCount, 2);
	});

	test('saving tells the webview the new name, so the header stops saying unsaved', async () => {
		await vscode.commands.executeCommand('fcsViewer.addFileToWorkspace', writeFcs('w-name.fcs'));
		await until('a sample', async () => (await debugState()).panels[0]?.samples.length === 1);
		assert.strictEqual((await debugState()).panels[0]!.postedWorkspaceName, undefined);

		await workspace('save', 'Named now');
		// The name reaches the header only through fcs/samples; renaming the
		// tab without re-posting left it reading "Unsaved workspace".
		assert.strictEqual((await debugState()).panels[0]!.postedWorkspaceName, 'Named now');
	});

	test('saving under an existing name replaces it rather than adding a second', async () => {
		await vscode.commands.executeCommand('fcsViewer.addFileToWorkspace', writeFcs('w-dup.fcs'));
		await until('a sample', async () => (await debugState()).panels[0]?.samples.length === 1);

		await workspace('save', 'Same name');
		await workspace('save', 'Same name');
		assert.strictEqual((await workspace<Listed[]>('list')).length, 1);
	});

	test('deleting removes only the named workspace', async () => {
		await vscode.commands.executeCommand('fcsViewer.addFileToWorkspace', writeFcs('w-del.fcs'));
		await until('a sample', async () => (await debugState()).panels[0]?.samples.length === 1);

		await workspace('save', 'Keep');
		await workspace('save', 'Drop');
		assert.strictEqual(await workspace<boolean>('delete', 'Drop'), true);
		assert.deepStrictEqual((await workspace<Listed[]>('list')).map((w) => w.name), ['Keep']);
		assert.strictEqual(await workspace<boolean>('delete', 'Drop'), false, 'deleting twice is not an error');
	});

	test('the automatic per-tab memory can be cleared without losing saved workspaces', async () => {
		await vscode.commands.executeCommand('fcsViewer.addFileToWorkspace', writeFcs('w-clear.fcs'));
		await until('a sample', async () => (await debugState()).panels[0]?.samples.length === 1);
		await workspace('save', 'Survivor');

		await vscode.commands.executeCommand('fcsViewer.debugReset');
		assert.deepStrictEqual((await workspace<Listed[]>('list')).map((w) => w.name), ['Survivor']);
	});
});
