import * as assert from 'assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { makeFcs } from '../unit/fixtures/makeFcs';
import { until } from './helpers';

interface PersistedSession {
	updatedAt: number;
	activeId?: string;
	samples: Array<{ id: string; uri: string; fileName: string }>;
}

interface DebugState {
	panelCount: number;
	persisted: Record<string, PersistedSession>;
	panels: Array<{
		panelId: string;
		activeId?: string;
		samples: Array<{ id: string; fileName: string; error?: string; eventCount: number }>;
		resident: string[];
	}>;
}

function debugState(): Thenable<DebugState> {
	return vscode.commands.executeCommand('fcsViewer.debugState') as Thenable<DebugState>;
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fcs-restore-'));
function writeFcs(name: string): vscode.Uri {
	const file = path.join(tmp, name);
	fs.writeFileSync(file, makeFcs({
		channels: [
			{ name: 'FSC-A', bits: 32, range: 1024 },
			{ name: 'B515-A', label: 'cd3', bits: 32, range: 1024 },
		],
		events: [[1, 2], [3, 4], [5, 6]],
		extraKeywords: { $CYT: 'LSRII' },
	}));
	return vscode.Uri.file(file);
}

suite('Restoring a viewer tab', function () {
	this.timeout(60_000);

	setup(async () => {
		await vscode.commands.executeCommand('fcsViewer.debugReset');
		await vscode.commands.executeCommand('workbench.action.closeAllEditors');
	});

	suiteTeardown(async () => {
		await vscode.commands.executeCommand('fcsViewer.debugReset');
		await vscode.commands.executeCommand('workbench.action.closeAllEditors');
	});

	test('brings back the same samples, ids and active selection', async () => {
		await vscode.commands.executeCommand('fcsViewer.addFileToWorkspace', writeFcs('r-one.fcs'));
		await until('the first sample', async () => (await debugState()).panels[0]?.samples.length === 1);
		await vscode.commands.executeCommand('fcsViewer.addFileToWorkspace', writeFcs('r-two.fcs'));
		// Settle on the FINAL state: addSample posts the sample list before it
		// activates the new sample, so reading activeId any earlier is a race.
		await until('the second sample to become active', async () => {
			const p = (await debugState()).panels[0];
			return p?.samples.length === 2 && p.activeId === 's2';
		});

		const before = await debugState();
		const panelId = before.panels[0]!.panelId;
		await until('the session to persist with the active sample', async () => {
			const s = (await debugState()).persisted[panelId];
			return s !== undefined && s.samples.length === 2 && s.activeId === 's2';
		});

		// Simulate a window reload: tabs go away but the persisted sessions
		// survive, then VS Code recreates the panel and hands the panelId back
		// through the webview's own state.
		await vscode.commands.executeCommand('fcsViewer.debugCloseTabs');
		assert.strictEqual((await debugState()).panelCount, 0);
		// panelCount only counts what the manager tracks. disposeAll used to
		// tear down the listeners and leave the webview on screen, so the
		// window reload this test simulates left a dead tab behind and the
		// assertion above still passed.
		await until('the webview tab to actually go away', async () =>
			vscode.window.tabGroups.all.flatMap((g) => g.tabs).length === 0);

		await vscode.commands.executeCommand('fcsViewer.debugRevive', panelId);
		await until('the samples to be adopted', async () => (await debugState()).panels[0]?.samples.length === 2);

		const after = (await debugState()).panels[0]!;
		assert.strictEqual(after.panelId, panelId);
		assert.deepStrictEqual(after.samples.map((s) => s.id), before.panels[0]!.samples.map((s) => s.id));
		assert.deepStrictEqual(after.samples.map((s) => s.fileName), ['r-one.fcs', 'r-two.fcs']);
		assert.ok(after.samples.every((s) => !s.error), 'both files still exist on disk');
		// Counts come from the persisted summaries, so the sidebar is populated
		// before anything is parsed.
		assert.ok(after.samples.every((s) => s.eventCount === 3));

		// activeId is set before the matrix finishes loading, so residency needs
		// its own wait rather than being read straight after.
		await until('the persisted active sample to reload', async () => (await debugState()).panels[0]?.activeId === 's2');
		await until('exactly one matrix resident', async () => {
			const resident = (await debugState()).panels[0]?.resident ?? [];
			return resident.length === 1 && resident[0] === 's2';
		});
	});

	test('a sample whose file vanished comes back flagged, and another takes over', async () => {
		const keep = writeFcs('r-keep.fcs');
		const doomed = writeFcs('r-doomed.fcs');
		await vscode.commands.executeCommand('fcsViewer.addFileToWorkspace', keep);
		await until('the first sample', async () => (await debugState()).panels[0]?.samples.length === 1);
		await vscode.commands.executeCommand('fcsViewer.addFileToWorkspace', doomed);
		await until('both samples', async () => (await debugState()).panels[0]?.samples.length === 2);

		const panelId = (await debugState()).panels[0]!.panelId;
		await until('the session to persist', async () => {
			const s = (await debugState()).persisted[panelId];
			return s !== undefined && s.samples.length === 2 && s.activeId !== undefined;
		});
		// The doomed file was opened last, so it is the persisted active sample.
		assert.strictEqual((await debugState()).persisted[panelId]!.activeId, 's2');

		await vscode.commands.executeCommand('fcsViewer.debugCloseTabs');
		fs.rmSync(doomed.fsPath);

		await vscode.commands.executeCommand('fcsViewer.debugRevive', panelId);
		await until('both rows to return', async () => (await debugState()).panels[0]?.samples.length === 2);

		const after = (await debugState()).panels[0]!;
		const gone = after.samples.find((s) => s.fileName === 'r-doomed.fcs')!;
		assert.ok(gone.error, 'the missing file should be flagged, not silently dropped');
		// The panel must not sit spinning on a file that cannot be read.
		await until('the healthy sample to take over', async () => (await debugState()).panels[0]?.activeId === 's1');
	});

	test('a fresh tab with no persisted session starts empty', async () => {
		await vscode.commands.executeCommand('fcsViewer.debugWorkspace', 'new');
		await until('a panel', async () => (await debugState()).panelCount === 1);
		assert.deepStrictEqual((await debugState()).panels[0]!.samples, []);
	});
});
