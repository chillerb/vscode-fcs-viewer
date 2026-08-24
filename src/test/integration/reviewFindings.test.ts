import * as assert from 'assert';
import * as vscode from 'vscode';
import { debugState, panel, tempDir, until, writeBigFcs, writeFcs, type DebugPanel } from './helpers';

interface Listed {
	name: string;
	samples: string[];
	activeId?: string;
	hasUi: boolean;
}

function workspace<T>(action: 'save' | 'open' | 'delete' | 'list', name?: string): Thenable<T> {
	return vscode.commands.executeCommand('fcsViewer.debugWorkspace', action, name) as Thenable<T>;
}

const tmp = tempDir('fcs-review-');

/**
 * Regressions for the defects the code review found. Each of these fails
 * against the code as reviewed, which is the point: the features they cover
 * were all "working" as far as the existing suites could tell.
 */
suite('Code review regressions', function () {
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

	// C1: the saved workspace carried the sample list but silently dropped the
	// card layout, because neither end of the UI round-trip was connected.
	test('a saved workspace carries the card layout, not just the samples', async () => {
		await vscode.commands.executeCommand('fcsViewer.addFileToWorkspace', writeFcs(tmp, 'c1.fcs'));
		await until('the webview to report its layout', async () => (await panel()).uiCards !== undefined);

		const before = (await panel()).uiCards;
		assert.ok(before !== undefined && before > 0, 'the webview should have created a default card');

		await workspace('save', 'With cards');
		const listed = await workspace<Listed[]>('list');
		assert.strictEqual(listed[0]?.hasUi, true, 'the saved workspace must include the UI blob');

		const opened = await workspace<string>('open', 'With cards');
		assert.ok(opened);
		await until('the reopened tab to restore its layout', async () => {
			const p = (await debugState()).panels.find((x) => x.panelId === opened);
			return p?.uiCards !== undefined;
		});
		const after = (await debugState()).panels.find((p) => p.panelId === opened)!;
		assert.strictEqual(after.uiCards, before, 'the reopened tab should have the same cards');
	});

	// C3: pins were taken on every activation and only released when the tab
	// closed, so the LRU ceiling rose with every sample the user clicked.
	test('clicking through samples does not hold every matrix resident', async () => {
		const files = ['c3-a.fcs', 'c3-b.fcs', 'c3-c.fcs', 'c3-d.fcs', 'c3-e.fcs'];
		for (const name of files) {
			await vscode.commands.executeCommand('fcsViewer.addFileToWorkspace', writeFcs(tmp, name));
		}
		await until('all five samples', async () => (await panel()).samples.length === files.length);
		await until('the webview to be ready', async () => (await panel()).ready);

		// Explicitly activate each one. Opening the files is not enough:
		// setActive defers until the webview is ready, so the early opens never
		// pin anything and the leak stays hidden.
		const { panelId } = await panel();
		for (let i = 1; i <= files.length; i++) {
			await vscode.commands.executeCommand('fcsViewer.debugSelect', panelId, `s${i}`);
			await until(`sample s${i} active`, async () => (await panel()).activeId === `s${i}`);
		}

		// CACHE_SIZE is 3, and one pin is legitimately held for the active
		// sample -- but not five.
		const resident = (await panel()).resident;
		assert.ok(
			resident.length <= 3,
			`expected at most 3 resident matrices, got ${resident.length}: ${resident.join(', ')}`,
		);
	});

	// V4: the context key that gates "Add to FCS Viewer Workspace" in the
	// explorer menu. Without it the entry shows with nothing to add to.
	test('the workspaceOpen context key follows whether a workspace exists', async () => {
		// getContextKeyValue is not exposed to extensions, so this asserts on
		// the state the key is computed from, which is the same condition.
		assert.strictEqual((await debugState()).panelCount, 0);

		await vscode.commands.executeCommand('fcsViewer.openFileInNewWorkspace', writeFcs(tmp, 'ctx.fcs'));
		await until('a workspace', async () => (await debugState()).panelCount === 1);

		await vscode.commands.executeCommand('fcsViewer.debugCloseTabs');
		assert.strictEqual((await debugState()).panelCount, 0);
	});

	// V4: double-click routes through the redirect editor, which should start a
	// workspace only when there is not one already.
	test('double-click starts a workspace, then adds to it', async () => {
		const first = writeFcs(tmp, 'dbl-one.fcs');
		const second = writeFcs(tmp, 'dbl-two.fcs');

		await vscode.commands.executeCommand('vscode.openWith', first, 'fcsViewer.fileRedirect');
		await until('a workspace with the first file', async () => {
			const s = await debugState();
			return s.panelCount === 1 && (s.panels[0]?.samples.length ?? 0) === 1;
		});

		await vscode.commands.executeCommand('vscode.openWith', second, 'fcsViewer.fileRedirect');
		await until('the second file to join it', async () => (await panel()).samples.length === 2);
		assert.strictEqual((await debugState()).panelCount, 1, 'the second file must not open a second workspace');
	});

	// H1: activeId was written before the await, and nothing serialised the
	// selections, so an older payload could arrive last.
	test('two quick sample switches leave the host and the webview agreeing', async () => {
		// The first file is deliberately large and the second tiny. Both reads
		// are genuinely async, so the small one finishes first and the large
		// one would otherwise post its payload last -- leaving the webview
		// showing a sample the host no longer considers active.
		await vscode.commands.executeCommand('fcsViewer.addFileToWorkspace', writeBigFcs(tmp, 'h1-big.fcs'));
		await until('the big sample', async () => (await panel()).samples.length === 1);
		await vscode.commands.executeCommand('fcsViewer.addFileToWorkspace', writeFcs(tmp, 'h1-small.fcs'));
		await until('both samples', async () => (await panel()).samples.length === 2);
		await until('the webview to be ready', async () => (await panel()).ready);

		// Drop the big file from the cache so selecting it really does read
		// and parse, rather than returning an already-resident matrix.
		await vscode.commands.executeCommand('fcsViewer.debugEvictCache');

		const p0 = await panel();
		const before = p0.acks.length;

		// Deliberately concurrent: this is the interleaving.
		await Promise.all([
			vscode.commands.executeCommand('fcsViewer.debugSelect', p0.panelId, 's1'),
			vscode.commands.executeCommand('fcsViewer.debugSelect', p0.panelId, 's2'),
		]);

		await until('a delivery for the newer selection', async () => (await panel()).acks.length > before);
		// Let any superseded payload that was going to arrive, arrive.
		await new Promise((r) => setTimeout(r, 750));

		const p: DebugPanel = await panel();
		const lastAck = p.acks[p.acks.length - 1]!;
		assert.strictEqual(
			lastAck.sampleId,
			p.activeId,
			'the last sample delivered to the webview must be the one the host considers active',
		);
	});

	/**
	 * N2, which review round two called a surviving pin leak. It is not one:
	 * there is no await between the supersession check and `registry.pin`, so
	 * a newer activation cannot slip in there, and by the time it can the
	 * outgoing id it unpins IS this sample. This test drives exactly the
	 * interleaving the finding describes -- pin taken, then superseded inside
	 * buildPayload -- and it passes with or without the self-releasing unpin
	 * that was added anyway.
	 *
	 * Kept because the invariant is the valuable part: pinned and active must
	 * be the same set once the dust settles, however the activations overlap.
	 */
	test('pinned and active stay the same set across a supersession', async () => {
		await vscode.commands.executeCommand('fcsViewer.addFileToWorkspace', writeBigFcs(tmp, 'n2-big.fcs'));
		await until('the big sample', async () => (await panel()).samples.length === 1);
		await vscode.commands.executeCommand('fcsViewer.addFileToWorkspace', writeFcs(tmp, 'n2-small.fcs'));
		await until('both samples', async () => (await panel()).samples.length === 2);
		await until('the webview to be ready', async () => (await panel()).ready);
		await vscode.commands.executeCommand('fcsViewer.debugEvictCache');

		const panelId = (await panel()).panelId;
		// Not concurrent: the window is narrow and timing into it by luck is
		// what made the H1 test miss this. The pin appearing IS the signal
		// that the first selection is past its load and inside buildPayload.
		const first = vscode.commands.executeCommand('fcsViewer.debugSelect', panelId, 's1');
		await until('the big sample to be pinned', async () => (await panel()).pinned.includes('s1'));
		await vscode.commands.executeCommand('fcsViewer.debugSelect', panelId, 's2');
		await first;

		await until('the small sample to become active', async () => (await panel()).activeId === 's2');
		await until('the superseded pin to be released', async () => {
			const p = await panel();
			return p.pinned.length === 1 && p.pinned[0] === 's2';
		});
	});
});
