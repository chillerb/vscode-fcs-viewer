import { useEffect } from 'react';
import type { Dispatch } from 'react';
import type { ActiveSamplePayload, HostToWebview, SampleSlice } from '../../common/protocol';
import { PROTOCOL_VERSION, isHostToWebview } from '../../common/protocol';
import { postToHost } from '../vscodeApi';
import { coerce, restoredSampleN, type PersistedState } from './persistence';
import { SampleData } from './SampleData';
import type { Action } from './appReducer';

/**
 * Rebuild a typed array from the bytes the host sent.
 *
 * A byteOffset that is not a multiple of the element size makes the zero-copy
 * view throw RangeError, so fall back to a copy rather than crashing the panel.
 */
function toFloat32(u8: Uint8Array): Float32Array {
	if (!(u8 instanceof Uint8Array)) {
		throw new Error('The event matrix did not survive the transport as a typed array.');
	}
	return u8.byteOffset % 4 === 0
		? new Float32Array(u8.buffer, u8.byteOffset, u8.byteLength / 4)
		: new Float32Array(u8.slice().buffer);
}

function toUint32(u8: Uint8Array): Uint32Array {
	if (!(u8 instanceof Uint8Array)) {
		throw new Error('The event index array did not survive the transport as a typed array.');
	}
	return u8.byteOffset % 4 === 0
		? new Uint32Array(u8.buffer, u8.byteOffset, u8.byteLength / 4)
		: new Uint32Array(u8.slice().buffer);
}

function sliceInit(slice: SampleSlice): {
	matrix: Float32Array;
	eventIds: Uint32Array;
	sampledCount: number;
	eventCount: number;
	channelCount: number;
	seed: number;
	clamped: boolean;
} {
	return {
		matrix: toFloat32(slice.matrix),
		eventIds: toUint32(slice.eventIds),
		sampledCount: slice.sampledCount,
		eventCount: slice.eventCount,
		channelCount: slice.channelCount,
		seed: slice.seed,
		clamped: slice.clamped ?? false,
	};
}

function toSampleData(p: ActiveSamplePayload): SampleData {
	return new SampleData({
		id: p.id,
		fileName: p.fileName,
		metadata: p.metadata,
		stats: p.stats,
		...sliceInit(p.slice),
		...(p.spillover ? { spillover: p.spillover } : {}),
		...(p.spilloverInverse ? { spilloverInverse: p.spilloverInverse } : {}),
	});
}

export function useHostMessages(dispatch: Dispatch<Action>): void {
	useEffect(() => {
		const onMessage = (event: MessageEvent<HostToWebview>): void => {
			const m = event.data;
			// VS Code delivers other traffic on this channel too, so anything
			// without a recognisable shape is not ours.
			if (!isHostToWebview(m)) {
				return;
			}
			try {
				switch (m.type) {
					case 'fcs/samples':
						dispatch({
							type: 'samples',
							panelId: m.panelId,
							samples: m.samples,
							...(m.activeId ? { activeId: m.activeId } : {}),
							...(m.workspaceName !== undefined ? { workspaceName: m.workspaceName } : {}),
						});
						return;
					case 'fcs/sample': {
						const data = toSampleData(m.payload);
						dispatch({
							type: 'sampleLoaded',
							data,
							activationId: m.payload.activationId,
							defaults: m.payload.defaults,
							maxSliceBytes: m.payload.maxSliceBytes,
						});
						postToHost({
							type: 'webview/dataReceived',
							sampleId: data.id,
							eventCount: data.eventCount,
							sampledCount: data.sampledCount,
							channelCount: data.channelCount,
						});
						return;
					}
					case 'fcs/slice': {
						// The reducer owns the stale check: a superseded reply can
						// still arrive, and there is no way to unsend a postMessage.
						dispatch({ type: 'sliceReceived', slice: m.payload, init: sliceInit(m.payload) });
						postToHost({
							type: 'webview/dataReceived',
							sampleId: m.payload.sampleId,
							eventCount: m.payload.eventCount,
							sampledCount: m.payload.sampledCount,
							channelCount: m.payload.channelCount,
						});
						return;
					}
					case 'fcs/stats':
						// Deliberately does NOT build the SampleData here: the
						// captured `current` may be a slice the user has already
						// replaced, and applying it would silently revert the plots.
						dispatch({ type: 'statsUpdated', sampleId: m.sampleId, stats: m.stats });
						return;
					case 'fcs/warnings':
						dispatch({ type: 'warnings', warnings: m.warnings });
						return;
					case 'fcs/progress':
						dispatch({ type: 'loading' });
						return;
					case 'fcs/error':
						if (m.requestId !== undefined) {
							dispatch({ type: 'sliceFailed', requestId: m.requestId, message: m.message });
							return;
						}
						dispatch({ type: 'error', message: m.message });
						return;
					case 'host/restoreState': {
						// A named workspace opening into this tab. Goes through the
						// same validation and migration as the webview's own
						// setState blob, so an old saved workspace is upgraded
						// rather than trusted.
						const patch = coerce(m.state as PersistedState | undefined);
						if (patch) {
							dispatch({ type: 'restore', state: patch });
						}
						return;
					}
				}
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				postToHost({ type: 'webview/error', message, ...(err instanceof Error && err.stack ? { stack: err.stack } : {}) });
				dispatch({ type: 'error', message });
			}
		};

		window.addEventListener('message', onMessage);
		return () => window.removeEventListener('message', onMessage);
	}, [dispatch]);

	useEffect(() => {
		// Read the persisted size synchronously rather than waiting for the
		// restore effect: the host sizes its first slice from this, and a later
		// answer would mean an immediate second round-trip.
		postToHost({ type: 'webview/ready', protocolVersion: PROTOCOL_VERSION, sampleN: restoredSampleN() });
	}, []);
}
