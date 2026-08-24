import { useEffect, useRef } from 'react';
import { postToHost } from '../vscodeApi';
import { useAppState, useDispatch } from './AppStateContext';

/** Long enough to absorb a double-change, far shorter than a round-trip. */
const DEBOUNCE_MS = 250;

/**
 * Ask the host for more events when the subsample grows.
 *
 * Shrinking never asks: rows arrive in permutation order, so a prefix of the
 * slice already in memory IS the smaller subsample. That makes 25k -> 5k
 * instant, and is the main reason the host gathers in permutation order.
 *
 * Two guards are needed. The debounce turns a fast double-change into one
 * request. The monotonic request id is the correctness backstop, because a
 * round-trip over a remote connection outlasts any debounce and a postMessage
 * cannot be unsent.
 */
export function useSliceRequests(confirmedBytes: number | undefined): void {
	const state = useAppState();
	const dispatch = useDispatch();
	const nextId = useRef(0);

	const data = state.data;
	const sampleId = data?.id;
	const sampledCount = data?.sampledCount ?? 0;
	const eventCount = data?.eventCount ?? 0;
	const wanted = state.sampleN;

	useEffect(() => {
		if (!data || sampleId === undefined) {
			return;
		}
		const target = wanted === null ? eventCount : Math.min(wanted, eventCount);
		// Already have at least this many, or the host cannot supply more.
		if (target <= sampledCount || sampledCount >= eventCount) {
			return;
		}
		const bytes = target * (data.channelCount * 4 + 4);
		const needsConfirmation = bytes > state.maxSliceBytes;
		if (needsConfirmation && confirmedBytes !== bytes) {
			return;
		}

		const timer = window.setTimeout(() => {
			const requestId = ++nextId.current;
			dispatch({ type: 'sliceRequested', requestId, n: wanted });
			postToHost({
				type: 'webview/requestSlice',
				sampleId,
				requestId,
				n: wanted,
				...(needsConfirmation ? { confirmed: true } : {}),
			});
		}, DEBOUNCE_MS);
		return () => clearTimeout(timer);
	}, [data, sampleId, sampledCount, eventCount, wanted, state.maxSliceBytes, confirmedBytes, dispatch]);
}
