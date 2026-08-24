import * as vscode from 'vscode';
import { invertSpillover } from '../common/fcs';
import { defaultCofactorFor } from '../common/fcs/transform';
import type { FcsWarning } from '../common/fcs/errors';
import {
	PROTOCOL_VERSION,
	isWebviewToHost,
	type ActiveSamplePayload,
	type HostToWebview,
	type SampleSummary,
	type SampleSlice,
	type WebviewToHost,
} from '../common/protocol';
import { getLogger } from './logger';
import { SampleRegistry, type LoadedSample } from './sampleRegistry';
import { getWebviewHtml } from './webviewHtml';
import type { PanelManager } from './panelManager';
import { handlePanelMessage, type PanelMessageContext } from './panelMessages';
import { decideSlice } from './sliceBudget';
import {
	loadSession,
	saveSession,
	type NamedWorkspace,
	type PersistedSample,
} from './workspaceStore';

export const VIEW_TYPE = 'fcsViewer.workspace';

/** Deliveries remembered for the debug/test hook. */
const MAX_ACKS = 20;

function config<T>(key: string, fallback: T): T {
	return vscode.workspace.getConfiguration('fcsViewer').get<T>(key) ?? fallback;
}

/** Where a file should land when opened. */
export type OpenTarget = 'focused' | 'new';

/**
 * One FCS Viewer tab: many samples, exactly one active. Selecting another
 * sample discards the previous matrix from this tab's view and posts the new
 * one, so plot cards persist and simply redraw.
 *
 * Several tabs can exist at once, each with its own samples and cards, so
 * different experiments stay apart. The expensive parsed matrices are shared
 * between tabs through matrixCache.
 */
export class FcsViewerPanel {
	private readonly disposables: vscode.Disposable[] = [];
	private readonly registry: SampleRegistry;
	private activeId: string | undefined;
	private ready = false;
	/**
	 * Acks from the webview, so tests can confirm the matrix actually arrived.
	 * Capped: this ships in the packaged extension and would otherwise grow by
	 * one record per delivered slice for as long as the tab is open. Readers
	 * only ever want the most recent one.
	 */
	private readonly acks: Array<{ sampleId: string; eventCount: number; sampledCount: number; channelCount: number }> = [];
	/** Sample selected before the webview finished booting. */
	private pendingActivation: string | undefined;
	/** Resolves once persisted samples have been adopted. */
	private readonly hydrated: Promise<void>;
	/** Subsample size the webview last asked for; also used for a fresh sample. */
	private requestedN: number | null | undefined;
	/** Monotonic; an activation whose id is stale must not post. */
	private activationSeq = 0;
	/** Cancels an in-flight re-slice when a newer request supersedes it. */
	private sliceCancellation: vscode.CancellationTokenSource | undefined;
	/**
	 * The webview's own UI blob, mirrored here so a named workspace can be
	 * saved without a round-trip. The webview posts it whenever it changes.
	 */
	private uiState: unknown;
	/** Pushed to the webview on ready, when opening a named workspace. */
	private pendingUiState: unknown;
	/** The panel's message-facing surface; see PanelMessageContext. */
	private readonly messageContext: PanelMessageContext;

	constructor(
		private readonly panel: vscode.WebviewPanel,
		private readonly context: vscode.ExtensionContext,
		private readonly manager: PanelManager,
		readonly panelId: string,
		private readonly seed?: NamedWorkspace,
	) {
		this.registry = new SampleRegistry(manager.cache);
		this.panel.webview.html = getWebviewHtml(this.panel.webview, context.extensionUri);
		this.disposables.push(
			this.panel.webview.onDidReceiveMessage((m: unknown) => {
				// Validated rather than cast. An unrecognised shape used to
				// reach assertNever and throw inside a floating promise, which
				// surfaces as an unhandled rejection and nothing else.
				if (!isWebviewToHost(m)) {
					getLogger().warn(`Ignoring an unrecognised webview message: ${JSON.stringify(m)?.slice(0, 200)}`);
					return;
				}
				void this.handleMessage(m).catch((err: unknown) => {
					getLogger().error(`Handling ${m.type} failed: ${err instanceof Error ? err.message : String(err)}`);
				});
			}),
			this.panel.onDidChangeViewState(() => {
				if (this.panel.active) {
					this.manager.noteFocused(this);
				}
			}),
		);
		this.panel.onDidDispose(() => this.dispose(), null, this.disposables);

		this.hydrated = this.hydrate();
		// Built after hydrated exists, since the router awaits it.
		this.messageContext = this.createMessageContext();
	}

	/**
	 * Adopt this tab's persisted samples. Nothing is parsed here: the cached
	 * counts are enough to draw the sidebar, and only the active sample's
	 * matrix is read, by setActive.
	 */
	private async hydrate(): Promise<void> {
		// A named workspace supersedes whatever this panel id last held: the
		// user asked for that set of samples specifically.
		if (this.seed) {
			this.workspaceName = this.seed.name;
			this.pendingUiState = this.seed.ui;
			// Take the saved subsample size now, so the first slice is already
			// the right size instead of being resized a round-trip later.
			const saved = (this.seed.ui as { sampleN?: unknown } | undefined)?.sampleN;
			if (typeof saved === 'number' || saved === null) {
				this.requestedN = saved;
			}
		}
		const session: { activeId?: string; samples: PersistedSample[] } | undefined =
			this.seed ?? loadSession(this.context, this.panelId);
		if (!session || session.samples.length === 0) {
			return;
		}
		// Set synchronously, before any await, so a fast webview/ready cannot
		// fall through to the first sample instead of the persisted one.
		this.pendingActivation = session.activeId;

		// The stats are independent, so they go out together: eight persisted
		// samples on a remote filesystem was eight serial round-trips on the
		// restore path. Adoption stays sequential, because it assigns the
		// sidebar's order.
		const errors = await Promise.all(session.samples.map(async (sample) => {
			try {
				await vscode.workspace.fs.stat(vscode.Uri.parse(sample.uri));
				return undefined;
			} catch (err) {
				const message = err instanceof Error ? err.message : 'File not found';
				getLogger().warn(`Restoring ${sample.fileName}: ${message}`);
				return message;
			}
		}));

		let firstHealthy: string | undefined;
		session.samples.forEach((sample, i) => {
			const error = errors[i];
			const id = this.registry.adopt(sample, error);
			if (error === undefined && firstHealthy === undefined) {
				firstHealthy = id;
			}
		});

		// A missing active file would otherwise leave the panel spinning.
		const active = this.pendingActivation;
		if (active === undefined || this.registry.summaries.find((s) => s.id === active)?.error !== undefined) {
			this.pendingActivation = firstHealthy;
		}
		this.postSamples();
	}

	private post(message: HostToWebview): void {
		void this.panel.webview.postMessage(message);
	}

	/** Set when this tab came from, or was saved as, a named workspace. */
	private workspaceName: string | undefined;

	private updateTitle(): void {
		const active = this.registry.summaries.find((s) => s.id === this.activeId);
		const subject = this.workspaceName ?? active?.fileName;
		this.panel.title = subject !== undefined ? `FCS Viewer: ${subject}` : 'FCS Viewer';
	}

	/** The name this tab was last saved or opened under, for the save prompt. */
	get savedName(): string | undefined {
		return this.workspaceName;
	}

	reveal(): void {
		this.panel.reveal(this.panel.viewColumn ?? vscode.ViewColumn.Active);
	}

	/** What the hidden fcsViewer.debugState command reports for this tab. */
	debugSnapshot(): {
		panelId: string;
		ready: boolean;
		activeId: string | undefined;
		samples: SampleSummary[];
		resident: string[];
		pinned: string[];
		acks: Array<{ sampleId: string; eventCount: number; sampledCount: number; channelCount: number }>;
		uiCards: number | undefined;
		postedWorkspaceName: string | undefined;
	} {
		return {
			panelId: this.panelId,
			postedWorkspaceName: this.postedWorkspaceName,
			ready: this.ready,
			activeId: this.activeId,
			samples: this.registry.summaries,
			resident: this.registry.ids.filter((id) => this.registry.isResident(id)),
			pinned: this.registry.ids.filter((id) => this.registry.isPinned(id)),
			acks: this.acks,
			// Card count from the webview's mirrored UI blob. This is the only
			// host-side view of what the webview actually restored, which is
			// what makes the workspace round-trip testable.
			uiCards: cardCount(this.uiState),
		};
	}

	/**
	 * Test hook: select a sample the way the webview would.
	 *
	 * Goes through the same message handler rather than calling setActive, so
	 * the ordering guarantees under test are the real ones.
	 */
	debugSelect(sampleId: string): Promise<void> {
		return this.handleMessage({ type: 'webview/selectSample', id: sampleId });
	}

	/** Everything a named workspace needs: the samples plus the card layout. */
	snapshot(name: string): NamedWorkspace {
		this.workspaceName = name;
		this.updateTitle();
		// The header shows the workspace name, and the name is only ever
		// carried by fcs/samples -- so saving has to re-post it or the webview
		// keeps saying "Unsaved workspace" until the next sample change.
		this.postSamples();
		return {
			name,
			savedAt: Date.now(),
			samples: this.registry.toPersisted(),
			...(this.activeId !== undefined ? { activeId: this.activeId } : {}),
			...(this.uiState !== undefined ? { ui: this.uiState } : {}),
		};
	}

	private async persist(): Promise<void> {
		await saveSession(this.context, this.panelId, {
			samples: this.registry.toPersisted(),
			...(this.activeId !== undefined ? { activeId: this.activeId } : {}),
		});
	}

	async addSample(uri: vscode.Uri): Promise<void> {
		// An unhydrated registry would mint a second id for a file the persisted
		// session already owns.
		await this.hydrated;

		const log = getLogger();
		const fileName = uri.path.split('/').pop() ?? uri.toString();
		try {
			const existing = this.registry.has(uri);
			if (existing !== undefined) {
				await this.setActive(existing);
				return;
			}

			const stat = await vscode.workspace.fs.stat(uri);
			const limitMB = config('maxFileSizeMB', 1024);
			if (stat.size > limitMB * 1024 * 1024) {
				const choice = await vscode.window.showWarningMessage(
					`${fileName} is ${(stat.size / 1048576).toFixed(0)} MB, above the ${limitMB} MB limit. Opening it may exhaust memory.`,
					{ modal: true },
					'Open Anyway',
				);
				if (choice !== 'Open Anyway') {
					return;
				}
			}

			const id = await vscode.window.withProgress(
				{ location: vscode.ProgressLocation.Notification, title: `Parsing ${fileName}…`, cancellable: true },
				(_progress, token) => this.registry.add(uri, token),
			);
			this.postSamples();
			await this.setActive(id);
			await this.persist();
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			log.error(`Could not open ${uri.toString()}: ${message}`);
			vscode.window.showErrorMessage(`FCS Viewer: ${message}`);
			this.postSamples();
			this.post({ type: 'fcs/error', code: 'LOAD_FAILED', message });
		}
	}

	/**
	 * The workspace name the webview was last actually told about.
	 *
	 * The header reads this name, and only fcs/samples carries it, so "renamed
	 * the tab but never posted" is a real and invisible failure mode. Recording
	 * what went out is what makes it testable from the host.
	 */
	private postedWorkspaceName: string | undefined;

	private postSamples(): void {
		this.postedWorkspaceName = this.workspaceName;
		this.post({
			type: 'fcs/samples',
			protocolVersion: PROTOCOL_VERSION,
			panelId: this.panelId,
			samples: this.registry.summaries,
			...(this.activeId !== undefined ? { activeId: this.activeId } : {}),
			...(this.workspaceName !== undefined ? { workspaceName: this.workspaceName } : {}),
		});
	}

	private async setActive(id: string): Promise<void> {
		if (!this.ready) {
			this.pendingActivation = id;
			return;
		}
		// The outgoing sample stops being re-sliced the moment another becomes
		// active, so its pin has done its job.
		if (this.activeId !== undefined && this.activeId !== id) {
			this.registry.unpin(this.activeId);
		}
		this.activeId = id;
		this.updateTitle();

		// Selecting a sample is a file read plus a parse, and nothing serialises
		// the messages that trigger it, so two quick selections overlap. Every
		// resumption point below checks that this activation is still the
		// newest; a superseded one stops working and never posts.
		const seq = ++this.activationSeq;
		const superseded = (): boolean => seq !== this.activationSeq;

		// Drives the webview's loading indicator. Without this nothing ever
		// sets status 'loading' and both the sidebar spinner and the status bar
		// are dead code.
		this.post({ type: 'fcs/progress', phase: 'reading', ratio: 0, fileName: this.registry.summaries.find((s) => s.id === id)?.fileName });

		let sample: LoadedSample;
		try {
			sample = await vscode.window.withProgress(
				{ location: vscode.ProgressLocation.Window, title: 'Loading FCS sample…' },
				() => this.registry.load(id),
			);
		} catch (err) {
			if (superseded()) {
				return;
			}
			const message = err instanceof Error ? err.message : String(err);
			this.registry.markFailed(id, message);
			this.postSamples();
			this.post({ type: 'fcs/error', code: 'LOAD_FAILED', message, sampleId: id });
			return;
		}
		if (superseded()) {
			return;
		}

		// Adopted entries carry counts from a previous session, which go stale
		// if the file changed on disk.
		this.registry.reconcile(id, sample);

		// Every re-slice depends on a cache hit; without this another tab could
		// evict it and turn a dropdown change into a remote re-read.
		this.registry.pin(id);

		const { payload, warnings } = await this.buildPayload(sample, 0, seq);
		if (superseded()) {
			// Release our own pin if this sample is no longer the active one.
			// The unpin at the top of setActive only ever targets the id that
			// was active when a newer activation started, so making the pin
			// self-releasing here is what keeps "pinned" and "active" the same
			// set no matter how activations interleave.
			if (this.activeId !== id) {
				this.registry.unpin(id);
			}
			return;
		}
		const started = Date.now();
		const delivered = await this.panel.webview.postMessage({ type: 'fcs/sample', payload } satisfies HostToWebview);
		getLogger().info(
			`Posted ${sample.fileName} slice ${payload.slice.sampledCount.toLocaleString()}/` +
			`${payload.slice.eventCount.toLocaleString()} ` +
			`(${(payload.slice.matrix.byteLength / 1048576).toFixed(2)} MB) in ${Date.now() - started}ms ` +
			`[gather ${this.lastGatherMs}ms] act#${seq}` +
			(delivered ? '' : ' -- webview was disposed'),
		);
		this.postSamples();
		this.updateTitle();
		void this.persist();

		// The cached metadata's warnings plus anything this activation produced,
		// unioned here rather than appended to the shared array.
		const allWarnings = [...sample.dataset.metadata.warnings, ...warnings];
		if (allWarnings.length > 0) {
			this.post({ type: 'fcs/warnings', sampleId: id, warnings: allWarnings });
		}

		// Quantiles are a second, chunked pass so neither the first paint nor a
		// subsample request waits on them.
		void (async (): Promise<void> => {
			try {
				const stats = await this.registry.computeQuantileStats(sample);
				if (this.activeId === id) {
					this.post({ type: 'fcs/stats', sampleId: id, stats });
				}
			} catch (err) {
				getLogger().warn(`Quantile pass failed: ${String(err)}`);
			}
		})();
	}

	private maxSliceBytes(): number {
		return config('maxSliceMB', 16) * 1024 * 1024;
	}

	private async buildSlice(
		sample: LoadedSample,
		requested: number | null,
		requestId: number,
		confirmed: boolean,
		token?: vscode.CancellationToken,
	): Promise<SampleSlice> {
		const { rows: n, clamped } = decideSlice({
			requested,
			eventCount: sample.dataset.eventCount,
			channelCount: sample.dataset.channelCount,
			maxBytes: this.maxSliceBytes(),
			confirmed,
		});

		const gatherStart = Date.now();
		const slice = await this.registry.slice(sample.id, n, requestId, token);
		const gatherMs = Date.now() - gatherStart;
		if (clamped) {
			slice.clamped = true;
		}
		this.lastGatherMs = gatherMs;
		return slice;
	}

	private lastGatherMs = 0;

	private async postSlice(slice: SampleSlice, fileName: string): Promise<void> {
		const started = Date.now();
		const delivered = await this.panel.webview.postMessage({ type: 'fcs/slice', payload: slice } satisfies HostToWebview);
		getLogger().info(
			`Posted ${fileName} slice ${slice.sampledCount.toLocaleString()}/${slice.eventCount.toLocaleString()} ` +
			`(${(slice.matrix.byteLength / 1048576).toFixed(2)} MB) in ${Date.now() - started}ms ` +
			`[gather ${this.lastGatherMs}ms] req#${slice.requestId}` +
			(delivered ? '' : ' -- webview was disposed'),
		);
	}

	/**
	 * Build the activation payload, plus any warnings this activation produced.
	 *
	 * The warnings are returned rather than pushed onto `meta.warnings`: that
	 * array belongs to the cached ParsedFile and is shared by every tab showing
	 * the file, so appending to it made the same warning accumulate a fresh
	 * copy on every re-activation.
	 */
	private async buildPayload(
		sample: LoadedSample,
		requestId: number,
		activationId: number,
	): Promise<{ payload: ActiveSamplePayload; warnings: FcsWarning[] }> {
		const { dataset } = sample;
		const meta = dataset.metadata;
		const warnings: FcsWarning[] = [];

		const cofactorSetting = config('defaultCofactor', 0);
		const sampleSize = config('defaultSampleSize', 5000);
		const defaults = {
			sampleSize,
			cofactor: cofactorSetting > 0 ? cofactorSetting : defaultCofactorFor(meta),
		};

		const wanted = this.requestedN === undefined ? sampleSize : this.requestedN;
		const slice = await this.buildSlice(sample, wanted, requestId, false);

		const payload: ActiveSamplePayload = {
			id: sample.id,
			activationId,
			fileName: sample.fileName,
			uri: sample.uri.toString(),
			metadata: meta,
			slice,
			stats: sample.stats,
			defaults,
			maxSliceBytes: this.maxSliceBytes(),
		};
		if (meta.spillover !== undefined) {
			payload.spillover = meta.spillover;
			const inv = invertSpillover(meta.spillover, warnings);
			if (inv !== undefined) {
				payload.spilloverInverse = inv;
			}
		}
		return { payload, warnings };
	}

	/**
	 * The panel's message-facing surface, handed to the router.
	 *
	 * Built once and reused: the router is a plain function over this
	 * interface, which keeps the switch out of this class without making every
	 * private field reachable from it.
	 */
	private createMessageContext(): PanelMessageContext {
		return {
		panelId: this.panelId,
		hydrated: this.hydrated,
		setRequestedN: (n) => {
			this.requestedN = n;
		},
		markReady: () => {
			this.ready = true;
		},
		post: (message) => {
			this.post(message);
		},
		postSamples: () => {
			this.postSamples();
		},
		takePendingUiState: () => {
			const ui = this.pendingUiState;
			this.pendingUiState = undefined;
			return ui;
		},
		activeId: () => this.activeId,
		firstHealthyId: () => this.registry.summaries.find((s) => !s.error)?.id,
		takePendingActivation: () => {
			const pending = this.pendingActivation;
			this.pendingActivation = undefined;
			return pending;
		},
		setActive: (id) => this.setActive(id),
		addSample: (uri) => this.addSample(uri),
		removeSample: (id) => this.removeSample(id),
		loadSample: (id, token) => this.registry.load(id, token),
		buildSlice: (sample, requested, requestId, confirmed, token) =>
			this.buildSlice(sample, requested, requestId, confirmed, token),
		postSlice: (slice, fileName) => this.postSlice(slice, fileName),
		beginSliceRequest: () => {
			this.sliceCancellation?.cancel();
			this.sliceCancellation?.dispose();
			const source = new vscode.CancellationTokenSource();
			this.sliceCancellation = source;
			return source;
		},
		endSliceRequest: (source) => {
			if (this.sliceCancellation === source) {
				this.sliceCancellation = undefined;
			}
			source.dispose();
		},
		recordAck: (ack) => {
			this.acks.push(ack);
			if (this.acks.length > MAX_ACKS) {
				this.acks.splice(0, this.acks.length - MAX_ACKS);
			}
		},
		setUiState: (state) => {
				this.uiState = state;
			},
		};
	}

	private handleMessage(m: WebviewToHost): Promise<void> {
		return handlePanelMessage(m, this.messageContext);
	}

	/** Drop a sample, activating another if it was the one being shown. */
	private async removeSample(id: string): Promise<void> {
		this.registry.remove(id);
		if (this.activeId === id) {
			this.activeId = undefined;
			const next = this.registry.summaries.find((s) => !s.error)?.id;
			if (next !== undefined) {
				await this.setActive(next);
			} else {
				this.updateTitle();
			}
		}
		this.postSamples();
		await this.persist();
	}

	/**
	 * Close the tab, the way the user closing it does.
	 *
	 * disposeAll used to reach for `panel.dispose()` at the call site; when the
	 * lifetime moved to PanelManager that turned into `dispose()`, which tears
	 * down the listeners but leaves the webview on screen -- a tab that looks
	 * like a viewer and answers nothing. onDidDispose drives dispose() from
	 * here, which is why dispose() has to tolerate being called twice.
	 */
	close(): void {
		this.panel.dispose();
	}

	private disposed = false;

	dispose(): void {
		if (this.disposed) {
			return;
		}
		this.disposed = true;
		this.sliceCancellation?.cancel();
		this.sliceCancellation?.dispose();
		this.sliceCancellation = undefined;
		this.manager.forget(this.panelId);
		// The persisted session is deliberately left in place: onDidDispose
		// fires both for a user closing the tab and for VS Code tearing down on
		// window close, with no way to tell them apart. Stale sessions are
		// pruned to the most recent few instead, and FCS: Clear Workspace
		// removes them outright.
		this.registry.dispose();
		for (const d of this.disposables) {
			d.dispose();
		}
		this.disposables.length = 0;
	}

}

/** Cards in a webview UI blob, or undefined when there is no blob yet. */
function cardCount(state: unknown): number | undefined {
	if (typeof state !== 'object' || state === null) {
		return undefined;
	}
	const cards = (state as { cards?: unknown }).cards;
	return Array.isArray(cards) ? cards.length : undefined;
}


