import * as vscode from 'vscode';
import { PROTOCOL_VERSION, assertNever, type HostToWebview, type WebviewToHost } from '../common/protocol';
import { getLogger } from './logger';
import type { SampleSlice } from '../common/protocol';
import type { LoadedSample } from './sampleRegistry';

/**
 * Everything the router is allowed to do to the panel it belongs to.
 *
 * The switch below used to be a hundred lines inside FcsViewerPanel, reaching
 * straight into a dozen private fields. Naming that surface explicitly is most
 * of the value of moving it out: it is now obvious what handling a message can
 * touch, and the panel's other responsibilities -- lifecycle, persistence,
 * slice budgeting -- are not reachable from here by accident.
 */
export interface PanelMessageContext {
	readonly panelId: string;
	/** Resolves once persisted samples have been adopted. */
	readonly hydrated: Promise<void>;

	/** Subsample size the webview last asked for. */
	setRequestedN(n: number | null | undefined): void;
	markReady(): void;

	post(message: HostToWebview): void;
	postSamples(): void;
	/** The UI blob a named workspace is waiting to push, if any. */
	takePendingUiState(): unknown;

	activeId(): string | undefined;
	/** First sample that is not in an error state. */
	firstHealthyId(): string | undefined;
	/** The sample to activate on ready, consumed by this call. */
	takePendingActivation(): string | undefined;
	setActive(id: string): Promise<void>;

	addSample(uri: vscode.Uri): Promise<void>;
	removeSample(id: string): Promise<void>;

	loadSample(id: string, token: vscode.CancellationToken): Promise<LoadedSample>;
	buildSlice(
		sample: LoadedSample,
		requested: number | null,
		requestId: number,
		confirmed: boolean,
		token: vscode.CancellationToken,
	): Promise<SampleSlice>;
	postSlice(slice: SampleSlice, fileName: string): Promise<void>;
	/** Cancellation for the in-flight re-slice; a newer request supersedes it. */
	beginSliceRequest(): vscode.CancellationTokenSource;
	endSliceRequest(source: vscode.CancellationTokenSource): void;

	recordAck(ack: { sampleId: string; eventCount: number; sampledCount: number; channelCount: number }): void;
	setUiState(state: unknown): void;
}

export async function handlePanelMessage(m: WebviewToHost, ctx: PanelMessageContext): Promise<void> {
	switch (m.type) {
		case 'webview/ready': {
			// The webview reports the size it last had, so the first slice is
			// already right rather than provoking a second round-trip.
			ctx.setRequestedN(m.sampleN);
			// Hydration stats files, which is slow enough over a remote
			// filesystem that ready reliably wins the race.
			await ctx.hydrated;
			ctx.markReady();
			getLogger().info(`Webview ready (protocol ${m.protocolVersion}, panel ${ctx.panelId}).`);
			// Both sides ship from the same dist/, so a mismatch means a webview
			// survived an extension update -- which is exactly what the version
			// field is for. Say so rather than failing later in a way that looks
			// like a data bug.
			if (m.protocolVersion !== PROTOCOL_VERSION) {
				const detail = `webview speaks protocol ${m.protocolVersion}, host speaks ${PROTOCOL_VERSION}`;
				getLogger().warn(`Protocol mismatch: ${detail}.`);
				void vscode.window.showWarningMessage(
					`FCS Viewer: this viewer tab is out of date (${detail}). Close and reopen it, or reload the window.`,
				);
			}
			ctx.postSamples();
			// A named workspace being opened into this tab. Pushed before
			// activation so the cards already exist when the first slice lands
			// -- the other order renders every card against no data and then
			// re-renders it.
			const ui = ctx.takePendingUiState();
			if (ui !== undefined) {
				ctx.post({ type: 'host/restoreState', state: ui });
			}
			const pending = ctx.takePendingActivation() ?? ctx.firstHealthyId();
			if (pending !== undefined) {
				await ctx.setActive(pending);
			}
			return;
		}

		case 'webview/selectSample':
			await ctx.setActive(m.id);
			return;

		case 'webview/requestSlice': {
			// After the guard, not before: a late request for a sample that is
			// no longer active must not set the size used for the NEXT sample's
			// first slice.
			if (m.sampleId !== ctx.activeId()) {
				return;
			}
			ctx.setRequestedN(m.n);
			// A re-slice that misses the cache is a full re-read and re-parse,
			// so it is cancellable like any other; a superseding request
			// cancels it.
			const cancellation = ctx.beginSliceRequest();
			try {
				const sample = await ctx.loadSample(m.sampleId, cancellation.token);
				const slice = await ctx.buildSlice(sample, m.n, m.requestId, m.confirmed ?? false, cancellation.token);
				await ctx.postSlice(slice, sample.fileName);
			} catch (err) {
				if (cancellation.token.isCancellationRequested) {
					return;
				}
				const message = err instanceof Error ? err.message : String(err);
				getLogger().error(`Slice request failed: ${message}`);
				ctx.post({ type: 'fcs/error', code: 'SLICE_FAILED', message, sampleId: m.sampleId, requestId: m.requestId });
			} finally {
				ctx.endSliceRequest(cancellation);
			}
			return;
		}

		case 'webview/addSample': {
			const picked = await vscode.window.showOpenDialog({
				canSelectMany: true,
				filters: { 'Flow Cytometry Standard': ['fcs', 'FCS'] },
				openLabel: 'Add to FCS Viewer',
			});
			for (const uri of picked ?? []) {
				await ctx.addSample(uri);
			}
			return;
		}

		case 'webview/removeSample':
			await ctx.removeSample(m.id);
			return;

		case 'webview/dataReceived':
			getLogger().info(
				`Webview received ${m.sampledCount} of ${m.eventCount} events x ${m.channelCount} for ${m.sampleId}.`,
			);
			ctx.recordAck({
				sampleId: m.sampleId,
				eventCount: m.eventCount,
				sampledCount: m.sampledCount,
				channelCount: m.channelCount,
			});
			return;

		case 'webview/log':
			getLogger()[m.level === 'debug' ? 'debug' : m.level](`[webview] ${m.message}`);
			return;

		case 'webview/error':
			getLogger().error(`[webview] ${m.message}${m.stack ? `\n${m.stack}` : ''}`);
			return;

		case 'webview/notify':
			if (m.level === 'error') {
				void vscode.window.showErrorMessage(m.message);
			} else if (m.level === 'warning') {
				void vscode.window.showWarningMessage(m.message);
			} else {
				void vscode.window.showInformationMessage(m.message);
			}
			return;

		case 'webview/copyToClipboard':
			await vscode.env.clipboard.writeText(m.text);
			return;

		case 'webview/persistState':
			// Held in memory only. This is what a named workspace snapshots, and
			// it is per panel -- a single workspace-state key would let whichever
			// tab persisted last overwrite every other tab. The webview's own
			// setState already covers a window reload.
			ctx.setUiState(m.state);
			return;

		default:
			assertNever(m);
	}
}
