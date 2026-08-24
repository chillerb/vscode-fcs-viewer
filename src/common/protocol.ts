import type { FcsMetadata, FcsSpillover } from './fcs/types';
import type { FcsWarning } from './fcs/errors';
import type { ChannelStats } from './fcs/stats';

export const PROTOCOL_VERSION = 3;

/** One entry in the Samples sidebar. Cheap enough to hold for every open file. */
export interface SampleSummary {
	id: string;
	fileName: string;
	/** uri.toString(), for display and identity only. */
	uri: string;
	eventCount: number;
	channelCount: number;
	cytometer?: string;
	/** Set when the file failed to load; the row shows an error state. */
	error?: string;
}

/**
 * The subsampled events the webview actually renders.
 *
 * Only the subsample crosses the wire, never the whole matrix. On a remote or
 * devcontainer setup the extension host and the webview renderer are on
 * opposite sides of a tunnel, and a 31 MB event matrix takes seconds to get
 * across; at the 5,000 default this is closer to 1 MB. Nothing in the webview
 * reads an event outside the current subsample.
 */
export interface SampleSlice {
	sampleId: string;
	/** Echoed from the request so a superseded reply can be discarded. */
	requestId: number;
	/** Rows present in this slice. */
	sampledCount: number;
	/** Events in the FILE. Never the row count. */
	eventCount: number;
	channelCount: number;
	/**
	 * Column-major Float32 over the SAMPLED rows: matrix[c * sampledCount + i].
	 *
	 * Sent as a Uint8Array rather than a Float32Array because it is the typed
	 * array VS Code preserves most reliably across every transport, including
	 * remote. The webview reconstructs it, guarding against a misaligned
	 * byteOffset.
	 */
	matrix: Uint8Array;
	/** Uint32 bytes: the original event index of row i, for the data table. */
	eventIds: Uint8Array;
	/** Prefix-nesting only holds between slices sharing a seed. */
	seed: number;
	/** Set when the host served fewer rows than asked for, to stay in budget. */
	clamped?: boolean;
}

export interface ActiveSamplePayload {
	id: string;
	/**
	 * Monotonic per panel, incremented on every activation.
	 *
	 * Selecting a sample starts a file read and a parse, so two quick
	 * selections can be in flight at once. Without this the older one can post
	 * last and leave the webview showing a sample the host no longer considers
	 * active. Same reasoning as SampleSlice.requestId -- a postMessage cannot
	 * be unsent, so the receiver has to be able to recognise a stale one.
	 */
	activationId: number;
	fileName: string;
	uri: string;
	metadata: FcsMetadata;
	slice: SampleSlice;
	/** Basic stats only; quantiles arrive later in an 'fcs/stats' message. */
	stats: ChannelStats[];
	spillover?: FcsSpillover;
	/** Row-major inverse of the spillover matrix, precomputed by the host. */
	spilloverInverse?: Float64Array;
	defaults: { sampleSize: number; cofactor: number };
	/** Transferring more than this many bytes needs explicit confirmation. */
	maxSliceBytes: number;
}

export type HostToWebview =
	// panelId lets a tab reclaim its own persisted sample list after a reload,
	// rather than some other tab's. Posted unconditionally on webview/ready,
	// even when there are no samples yet.
	| {
			type: 'fcs/samples';
			protocolVersion: number;
			panelId: string;
			samples: SampleSummary[];
			activeId?: string;
			/** Set once this workspace has been saved under a name. */
			workspaceName?: string;
		}
	| { type: 'fcs/sample'; payload: ActiveSamplePayload }
	| { type: 'fcs/slice'; payload: SampleSlice }
	| { type: 'fcs/stats'; sampleId: string; stats: ChannelStats[] }
	| { type: 'fcs/progress'; phase: 'reading' | 'parsing' | 'stats'; ratio: number; fileName?: string }
	| { type: 'fcs/warnings'; sampleId: string; warnings: FcsWarning[] }
	| { type: 'fcs/error'; code: string; message: string; sampleId?: string; requestId?: number }
	| { type: 'host/restoreState'; state: unknown };

export type WebviewToHost =
	// sampleN rides along so the first slice after a reload is already the size
	// the user last chose, instead of provoking an immediate second round-trip.
	| { type: 'webview/ready'; protocolVersion: number; sampleN?: number | null }
	| { type: 'webview/selectSample'; id: string }
	| { type: 'webview/addSample' }
	| { type: 'webview/removeSample'; id: string }
	| { type: 'webview/dataReceived'; sampleId: string; eventCount: number; sampledCount: number; channelCount: number }
	// n === null means every event; the host may clamp and say so.
	| { type: 'webview/requestSlice'; sampleId: string; requestId: number; n: number | null; confirmed?: boolean }
	| { type: 'webview/log'; level: 'debug' | 'info' | 'warn' | 'error'; message: string }
	| { type: 'webview/error'; message: string; stack?: string }
	| { type: 'webview/notify'; level: 'info' | 'warning' | 'error'; message: string }
	| { type: 'webview/copyToClipboard'; text: string }
	| { type: 'webview/persistState'; state: unknown };

export function isHostToWebview(m: unknown): m is HostToWebview {
	return typeof m === 'object' && m !== null && typeof (m as { type?: unknown }).type === 'string';
}

export function isWebviewToHost(m: unknown): m is WebviewToHost {
	return typeof m === 'object' && m !== null && typeof (m as { type?: unknown }).type === 'string';
}

/** Exhaustiveness guard for message switches. */
export function assertNever(x: never): never {
	throw new Error(`Unhandled message: ${JSON.stringify(x)}`);
}
