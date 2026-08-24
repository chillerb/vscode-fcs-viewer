import * as vscode from 'vscode';
import { FcsViewerPanel, VIEW_TYPE, type OpenTarget } from './fcsViewerPanel';
import { MatrixCache } from './matrixCache';
import { loadSessions, type NamedWorkspace } from './workspaceStore';

/**
 * Owns the open viewer tabs and the matrices they share.
 *
 * All of this used to be static state on FcsViewerPanel: a module-lifetime map
 * of panels, a module-lifetime "focused" pointer, and a module-global matrix
 * cache. Sharing the cache across tabs is a genuine requirement -- two tabs on
 * one file must not parse it twice -- but nothing about that requires the
 * state to be globally reachable, and the difference is why a pin leak was
 * easy to introduce and hard to see: no object owned the lifetime.
 *
 * One instance is created by activate() and passed to everything that needs
 * it, which also removes the test-only reset hooks that existed purely so
 * suites could get a clean slate.
 */
export class PanelManager {
	private readonly panels = new Map<string, FcsViewerPanel>();
	/** Most recently focused panel; the target of "current tab" actions. */
	private focusedPanelId: string | undefined;
	readonly cache = new MatrixCache();

	constructor(private readonly context: vscode.ExtensionContext) {}

	get count(): number {
		return this.panels.size;
	}

	/** The tab commands act on, or undefined when no viewer is open. */
	get focused(): FcsViewerPanel | undefined {
		const byId = this.focusedPanelId ? this.panels.get(this.focusedPanelId) : undefined;
		return byId ?? [...this.panels.values()].pop();
	}

	/** Called by a panel when it becomes the active editor. */
	noteFocused(panel: FcsViewerPanel): void {
		this.focusedPanelId = panel.panelId;
	}

	/** Called by a panel as it disposes. */
	forget(panelId: string): void {
		this.panels.delete(panelId);
		if (this.focusedPanelId === panelId) {
			this.focusedPanelId = undefined;
		}
		this.publishContext();
	}

	/**
	 * Drives the `fcsViewer.workspaceOpen` context key, which is what gates
	 * "Add to FCS Viewer Workspace" in the explorer menu. Set from the one
	 * place that already knows when a workspace comes and goes.
	 */
	private publishContext(): void {
		void vscode.commands.executeCommand('setContext', 'fcsViewer.workspaceOpen', this.panels.size > 0);
	}

	/**
	 * Open a file into a viewer tab. 'focused' reuses the most recently focused
	 * tab, creating one if none exists; 'new' always creates one.
	 */
	async openIn(target: OpenTarget, uri?: vscode.Uri): Promise<FcsViewerPanel> {
		const existing = this.focused;
		let panel: FcsViewerPanel;
		if (target === 'focused' && existing) {
			panel = existing;
			panel.reveal();
		} else {
			panel = this.create();
		}
		if (uri) {
			await panel.addSample(uri);
		}
		return panel;
	}

	/**
	 * Open a saved workspace in a tab of its own.
	 *
	 * Always a new tab: the samples and the card layout arrive as a set, and
	 * dropping them onto a tab someone is already working in would silently
	 * discard that work.
	 */
	openWorkspace(entry: NamedWorkspace): FcsViewerPanel {
		return this.create(undefined, entry);
	}

	private create(panelId?: string, seed?: NamedWorkspace, retainContext = true): FcsViewerPanel {
		const webviewPanel = vscode.window.createWebviewPanel(
			VIEW_TYPE,
			'FCS Viewer',
			vscode.ViewColumn.Active,
			{
				enableScripts: true,
				// Without this, switching editor tabs destroys the webview and
				// forces a re-parse plus a full re-post of the matrix, losing
				// all card state. The memory cost is the matrix we already hold.
				retainContextWhenHidden: retainContext,
				localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, 'dist')],
			},
		);
		return this.adopt(webviewPanel, panelId ?? crypto.randomUUID(), seed);
	}

	private adopt(webviewPanel: vscode.WebviewPanel, panelId: string, seed?: NamedWorkspace): FcsViewerPanel {
		const panel = new FcsViewerPanel(webviewPanel, this.context, this, panelId, seed);
		this.panels.set(panelId, panel);
		this.focusedPanelId = panelId;
		this.publishContext();
		return panel;
	}

	/**
	 * Restore a tab after a window reload. The panelId travels in the webview's
	 * own persisted state, which is how a tab reclaims its own sample list
	 * rather than some other tab's.
	 */
	revive(webviewPanel: vscode.WebviewPanel, state: unknown): void {
		webviewPanel.webview.options = {
			enableScripts: true,
			localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, 'dist')],
		};
		this.adopt(webviewPanel, readPanelId(state) ?? crypto.randomUUID());
	}

	/** Diagnostics for the hidden fcsViewer.debugState command. */
	debugState(): unknown {
		const focused = this.focused;
		return {
			persisted: loadSessions(this.context).sessions,
			open: this.panels.size > 0,
			panelCount: this.panels.size,
			focusedId: focused?.panelId,
			panels: [...this.panels.values()].map((p) => p.debugSnapshot()),
			// Kept flat for the existing tests, which predate multiple tabs.
			ready: focused?.debugSnapshot().ready ?? false,
			activeId: focused?.debugSnapshot().activeId,
			samples: focused?.debugSnapshot().samples ?? [],
			acks: focused?.debugSnapshot().acks ?? [],
		};
	}

	/**
	 * Test hook: run the restore path without reloading the window, which a
	 * test host cannot do.
	 */
	debugRevive(panelId: string): FcsViewerPanel {
		return this.create(panelId);
	}

	/**
	 * Test hook: select a sample the way the webview would.
	 *
	 * Goes through the same message handler rather than calling setActive, so
	 * the ordering guarantees under test are the real ones.
	 */
	debugSelect(panelId: string, sampleId: string): Promise<void> {
		return this.panels.get(panelId)?.debugSelect(sampleId) ?? Promise.resolve();
	}

	/** Test hook: close every tab so suites do not leak state into each other. */
	disposeAll(): void {
		// close(), not dispose(): the tab has to actually go away. See
		// FcsViewerPanel.close.
		for (const p of [...this.panels.values()]) {
			p.close();
		}
		this.panels.clear();
		this.focusedPanelId = undefined;
		this.publishContext();
	}
}

function readPanelId(state: unknown): string | undefined {
	if (typeof state !== 'object' || state === null) {
		return undefined;
	}
	const id = (state as { panelId?: unknown }).panelId;
	return typeof id === 'string' && id.length > 0 ? id : undefined;
}
