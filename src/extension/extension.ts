import * as vscode from 'vscode';
import { FcsRedirectEditorProvider } from './fcsRedirectEditorProvider';
import { PanelManager } from './panelManager';
import { enqueue } from './openQueue';
import { VIEW_TYPE, type OpenTarget } from './fcsViewerPanel';
import { disposeLogger } from './logger';
import {
	clearWorkspace,
	deleteWorkspace,
	loadWorkspaces,
	pruneStored,
	saveWorkspace,
	type NamedWorkspace,
} from './workspaceStore';

function isFcs(uri: vscode.Uri): boolean {
	return uri.path.toLowerCase().endsWith('.fcs');
}

/**
 * Explorer commands are invoked as (uri, uris): the second argument carries the
 * whole multi-selection. Ignoring it means right-clicking five selected files
 * opens only the one under the cursor.
 */
function targets(uri?: vscode.Uri, uris?: vscode.Uri[]): vscode.Uri[] {
	const candidates = uris && uris.length > 0 ? uris : uri ? [uri] : [];
	const fromEditor = candidates.length === 0 ? vscode.window.activeTextEditor?.document.uri : undefined;
	return [...candidates, ...(fromEditor ? [fromEditor] : [])].filter(isFcs);
}

async function openFiles(
	manager: PanelManager,
	target: OpenTarget,
	uri?: vscode.Uri,
	uris?: vscode.Uri[],
): Promise<void> {
	const files = targets(uri, uris);
	if (files.length === 0) {
		// No file to act on: still give the user a viewer to drop samples into.
		await enqueue(() => manager.openIn(target));
		return;
	}
	// Only the first file decides whether a new tab is created; the rest join it.
	let mode: OpenTarget = target;
	for (const file of files) {
		const use = mode;
		await enqueue(() => manager.openIn(use, file));
		mode = 'focused';
	}
}

interface WorkspacePick extends vscode.QuickPickItem {
	entry: NamedWorkspace | undefined;
}

function describe(w: NamedWorkspace): WorkspacePick {
	return {
		label: w.name,
		description: `${w.samples.length} sample${w.samples.length === 1 ? '' : 's'}`,
		...(w.savedAt > 0 ? { detail: `Saved ${new Date(w.savedAt).toLocaleString()}` } : {}),
		entry: w,
	};
}

/**
 * Pick a saved workspace, optionally offering a fresh empty one first.
 *
 * "Open Workspace" covers both opening a saved set-up and starting a new one,
 * because from the user's side those are the same intent -- get me a workspace
 * -- and two commands for it was one of the things that made the palette
 * cluttered.
 */
async function pickWorkspace(
	context: vscode.ExtensionContext,
	placeHolder: string,
	includeNew: boolean,
): Promise<{ entry: NamedWorkspace | undefined } | undefined> {
	const saved = loadWorkspaces(context);
	if (!includeNew && saved.length === 0) {
		void vscode.window.showInformationMessage(
			'FCS Viewer: no saved workspaces yet. Use "FCS Viewer: Save Workspace…" to make one.',
		);
		return undefined;
	}
	const items: WorkspacePick[] = [
		...(includeNew
			? [{
				label: '$(add) New workspace',
				description: 'Start empty',
				entry: undefined,
			} satisfies WorkspacePick]
			: []),
		...(includeNew && saved.length > 0
			? [{ label: 'Saved', kind: vscode.QuickPickItemKind.Separator, entry: undefined } as WorkspacePick]
			: []),
		...saved.map(describe),
	];
	const picked = await vscode.window.showQuickPick(items, { placeHolder, matchOnDescription: true });
	return picked ? { entry: picked.entry } : undefined;
}

export function activate(context: vscode.ExtensionContext): void {
	void pruneStored(context);

	// One owner for the open tabs and the matrices they share, rather than
	// module-level statics. See PanelManager.
	const manager = new PanelManager(context);

	context.subscriptions.push(
		FcsRedirectEditorProvider.register(context, manager),

		// Context-menu only. "Open in FCS Viewer" always starts a workspace of
		// its own; "Add to" only appears when there is one to add to, which is
		// why it needs no fallback here.
		vscode.commands.registerCommand('fcsViewer.openFileInNewWorkspace', (uri?: vscode.Uri, uris?: vscode.Uri[]) =>
			openFiles(manager, 'new', uri, uris),
		),
		vscode.commands.registerCommand('fcsViewer.addFileToWorkspace', (uri?: vscode.Uri, uris?: vscode.Uri[]) =>
			openFiles(manager, 'focused', uri, uris),
		),
		vscode.commands.registerCommand('fcsViewer.saveWorkspace', async () => {
			const panel = manager.focused;
			if (!panel) {
				void vscode.window.showInformationMessage('FCS Viewer: open a workspace first.');
				return;
			}
			const name = await vscode.window.showInputBox({
				prompt: 'Name for this workspace (its samples and plot cards)',
				value: panel.savedName ?? '',
				placeHolder: 'e.g. Panel A — day 7',
				validateInput: (v) => (v.trim() === '' ? 'Give the workspace a name.' : undefined),
			});
			if (name === undefined) {
				return;
			}
			const trimmed = name.trim();
			const existing = loadWorkspaces(context).some((w) => w.name === trimmed);
			if (existing && trimmed !== panel.savedName) {
				const choice = await vscode.window.showWarningMessage(
					`A workspace called "${trimmed}" already exists. Replace it?`,
					{ modal: true },
					'Replace',
				);
				if (choice !== 'Replace') {
					return;
				}
			}
			await saveWorkspace(context, panel.snapshot(trimmed));
			void vscode.window.showInformationMessage(`FCS Viewer: saved workspace "${trimmed}".`);
		}),
		vscode.commands.registerCommand('fcsViewer.openWorkspace', async () => {
			const picked = await pickWorkspace(context, 'Open a workspace', true);
			if (!picked) {
				return;
			}
			await enqueue(async () =>
				picked.entry ? manager.openWorkspace(picked.entry) : manager.openIn('new'),
			);
		}),
		vscode.commands.registerCommand('fcsViewer.discardWorkspace', async () => {
			const picked = await pickWorkspace(context, 'Discard a saved workspace', false);
			const entry = picked?.entry;
			if (!entry) {
				return;
			}
			const choice = await vscode.window.showWarningMessage(
				`Discard the saved workspace "${entry.name}"? The FCS files themselves are untouched.`,
				{ modal: true },
				'Discard',
			);
			if (choice === 'Discard' && (await deleteWorkspace(context, entry.name))) {
				void vscode.window.showInformationMessage(`FCS Viewer: discarded workspace "${entry.name}".`);
			}
		}),

		vscode.commands.registerCommand('fcsViewer.debugState', () => manager.debugState()),
		vscode.commands.registerCommand('fcsViewer.debugSelect', (panelId: string, sampleId: string) =>
			manager.debugSelect(panelId, sampleId),
		),
		// Forces the next activation to really read and parse, which is what
		// makes a load slow enough for an ordering race to be reproducible.
		vscode.commands.registerCommand('fcsViewer.debugEvictCache', () => manager.cache.clear()),
		// Named-workspace commands are all prompts, which a test host cannot
		// drive; this is the same code path with the prompts removed.
		vscode.commands.registerCommand(
			'fcsViewer.debugWorkspace',
			async (action: 'save' | 'open' | 'new' | 'delete' | 'list', name?: string) => {
				switch (action) {
					// The "New workspace" entry in the Open Workspace quick pick.
					case 'new':
						return (await enqueue(() => manager.openIn('new'))).panelId;
					case 'save': {
						const panel = manager.focused;
						if (!panel || name === undefined) {
							return undefined;
						}
						await saveWorkspace(context, panel.snapshot(name));
						return name;
					}
					case 'open': {
						const entry = loadWorkspaces(context).find((w) => w.name === name);
						return entry ? (await enqueue(async () => manager.openWorkspace(entry))).panelId : undefined;
					}
					case 'delete':
						return name === undefined ? false : deleteWorkspace(context, name);
					case 'list':
						return loadWorkspaces(context).map((w) => ({
							name: w.name,
							samples: w.samples.map((x) => x.fileName),
							activeId: w.activeId,
							hasUi: w.ui !== undefined,
						}));
				}
			},
		),
		vscode.commands.registerCommand('fcsViewer.debugRevive', (panelId: string) =>
			manager.debugRevive(panelId).panelId,
		),
		// Closes tabs but deliberately leaves the persisted sessions alone,
		// which is what a window reload looks like from the extension's side.
		vscode.commands.registerCommand('fcsViewer.debugCloseTabs', () => {
			manager.disposeAll();
			manager.cache.clear();
		}),
		vscode.commands.registerCommand('fcsViewer.debugReset', async () => {
			manager.disposeAll();
			manager.cache.clear();
			await clearWorkspace(context);
		}),

		vscode.window.registerWebviewPanelSerializer(VIEW_TYPE, {
			deserializeWebviewPanel(panel: vscode.WebviewPanel, state: unknown): Thenable<void> {
				manager.revive(panel, state);
				return Promise.resolve();
			},
		}),
	);
}

export function deactivate(): void {
	disposeLogger();
}
