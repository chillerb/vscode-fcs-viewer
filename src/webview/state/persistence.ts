import { getPersistedState, setPersistedState } from '../vscodeApi';
import type { AppState } from './appReducer';
import { coerce, PERSISTED_VERSION, type PersistedState } from './persistedState';

export { coerce, PERSISTED_VERSION, type PersistedState } from './persistedState';

/**
 * retainContextWhenHidden covers tab switches; this covers what it does not --
 * window reload, extension host restart, hot exit. UI config only: the sample
 * list is host-owned state, and typed arrays do not survive setState anyway.
 *
 * The panelId is written as soon as it is known, without waiting for the panel
 * to reach 'ready'. A tab reloaded while still parsing would otherwise come
 * back with no id and be unable to find its samples.
 */
export function persist(state: AppState): void {
	if (state.panelId === undefined) {
		return;
	}
	const snapshot: PersistedState = { version: PERSISTED_VERSION, panelId: state.panelId };
	if (state.status === 'ready') {
		snapshot.activeTab = state.activeTab;
		snapshot.sampleN = state.sampleN;
		snapshot.compensate = state.compensate;
		snapshot.defaults = state.defaults;
		snapshot.cards = state.cards;
		snapshot.table = state.table;
		snapshot.manualMapping = state.manualMapping;
		snapshot.layout = state.layout;
	}
	setPersistedState(snapshot);
}

/**
 * The subsample size, read synchronously so it can ride on webview/ready. The
 * host sizes its first slice from this; answering later would mean an
 * immediate second round-trip.
 */
export function restoredSampleN(): number | undefined {
	const saved = getPersistedState<PersistedState>();
	const n = saved?.sampleN;
	return typeof n === 'number' ? n : undefined;
}

export function restore(): Partial<AppState> | undefined {
	return coerce(getPersistedState<PersistedState>());
}
