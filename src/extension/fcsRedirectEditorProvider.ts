import * as vscode from 'vscode';
import type { PanelManager } from './panelManager';
import { getLogger } from './logger';
import { enqueue } from './openQueue';

export const REDIRECT_VIEW_TYPE = 'fcsViewer.fileRedirect';

/** How long to wait for the placeholder tab to appear before giving up. */
const TAB_WAIT_MS = 5000;

/**
 * A custom editor that exists only to hand its file to the FCS Viewer panel and
 * then close itself.
 *
 * VS Code has no API to intercept or veto an editor open, and claiming the
 * *.fcs glob is the only way to stop these files being decoded into a text
 * buffer -- 8-31MB of binary floats. Watching for .fcs text editors and closing
 * them afterwards would not help: by then the read has already happened, which
 * is the exact cost being avoided.
 */
export class FcsRedirectEditorProvider implements vscode.CustomReadonlyEditorProvider {
	static register(context: vscode.ExtensionContext, manager: PanelManager): vscode.Disposable {
		return vscode.window.registerCustomEditorProvider(
			REDIRECT_VIEW_TYPE,
			new FcsRedirectEditorProvider(context, manager),
			{
				webviewOptions: { retainContextWhenHidden: false },
				supportsMultipleEditorsPerDocument: false,
			},
		);
	}

	private constructor(
		private readonly context: vscode.ExtensionContext,
		private readonly manager: PanelManager,
	) {}

	/** No I/O here: reading would pay the file cost twice. */
	openCustomDocument(uri: vscode.Uri): vscode.CustomDocument {
		return { uri, dispose: (): void => undefined };
	}

	async resolveCustomEditor(document: vscode.CustomDocument, webviewPanel: vscode.WebviewPanel): Promise<void> {
		// Honest wording, because if the close ever fails this is what the user
		// is left looking at.
		webviewPanel.webview.html = `<!DOCTYPE html><html><body style="
			font-family: var(--vscode-font-family); color: var(--vscode-descriptionForeground);
			display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0;">
			Opened in the FCS Viewer panel. You can close this tab.
		</body></html>`;

		// Scheduled before the await: closing should not wait on the parse.
		this.closeTabFor(document.uri);

		await enqueue(() => this.manager.openIn('focused', document.uri));
	}

	/**
	 * Close the placeholder tab.
	 *
	 * Uses tabGroups.close on the specific tab rather than
	 * workbench.action.closeActiveEditor: by the time this runs the viewer
	 * panel is usually the active tab, so closing "the active editor" would
	 * close the viewer itself. The match requires both viewType and uri --
	 * matching on uri alone would also hit a TabInputText for the same file and
	 * destroy the user's deliberate "Open With -> Text Editor" choice.
	 */
	private closeTabFor(uri: vscode.Uri): void {
		const immediate = findRedirectTab(uri);
		if (immediate) {
			void vscode.window.tabGroups.close(immediate, false);
			return;
		}

		// The tab is normally present already, but that is not contractual and
		// is false on the window-restore path.
		//
		// Deliberately NOT registered on context.subscriptions: both paths below
		// dispose the listener and clear the timer themselves, so routing them
		// through a list that only empties on deactivate would retain two dead
		// entries per file opened -- 400 of them for a folder of 200 samples.
		let timer: ReturnType<typeof setTimeout> | undefined;
		const done = (): void => {
			sub.dispose();
			if (timer !== undefined) {
				clearTimeout(timer);
				timer = undefined;
			}
		};
		const sub = vscode.window.tabGroups.onDidChangeTabs(() => {
			const tab = findRedirectTab(uri);
			if (!tab) {
				return;
			}
			done();
			void vscode.window.tabGroups.close(tab, false);
		});
		timer = setTimeout(() => {
			done();
			getLogger().warn(`Could not find the placeholder tab for ${uri.toString()} to close it.`);
		}, TAB_WAIT_MS);
	}
}

export function findRedirectTab(uri: vscode.Uri): vscode.Tab | undefined {
	const target = uri.toString();
	for (const group of vscode.window.tabGroups.all) {
		for (const tab of group.tabs) {
			const input = tab.input;
			if (
				input instanceof vscode.TabInputCustom &&
				input.viewType === REDIRECT_VIEW_TYPE &&
				input.uri.toString() === target
			) {
				return tab;
			}
		}
	}
	return undefined;
}
