import { useEffect, useMemo, useRef, useState, type ReactElement } from 'react';
import { useAppState, useDispatch } from './state/AppStateContext';
import { useHostMessages } from './state/useHostMessages';
import { useSliceRequests } from './state/useSliceRequests';
import { persist, restore } from './state/persistence';
import { buildIndex, summariseMapping } from './state/channelResolver';
import { SamplesSidebar } from './components/SamplesSidebar';
import { AppHeader } from './components/AppHeader';
import { StatusBar } from './components/StatusBar';
import { TabBar } from './components/TabBar';
import { EmptyState } from './components/EmptyState';
import { Resizer } from './components/ui/Resizer';
import { SAMPLES_LIMITS } from './state/layout';
import { OverviewView } from './views/OverviewView';
import { PlotsView } from './views/PlotsView';
import { DataTableView } from './views/DataTableView';
import './App.css';

export function App(): ReactElement {
	const state = useAppState();
	const dispatch = useDispatch();
	useHostMessages(dispatch);

	// Bytes the user has explicitly approved transferring, so an oversized
	// subsample is a deliberate choice rather than an accidental stall.
	const [confirmedBytes, setConfirmedBytes] = useState<number | undefined>(undefined);
	useSliceRequests(confirmedBytes);

	// Restore config once, before any sample arrives.
	const restored = useRef(false);
	useEffect(() => {
		if (restored.current) {
			return;
		}
		restored.current = true;
		const saved = restore();
		if (saved) {
			dispatch({ type: 'restore', state: saved });
		}
	}, [dispatch]);

	// setState serialises to the workspace store, so debounce it.
	useEffect(() => {
		const t = window.setTimeout(() => persist(state), 300);
		return () => clearTimeout(t);
	}, [state]);

	// Re-resolve card channels whenever the active sample changes.
	const manual = useMemo(
		() => new Map(Object.entries(state.manualMapping)),
		[state.manualMapping],
	);
	const index = useMemo(() => (state.data ? buildIndex(state.data.metadata) : undefined), [state.data]);
	useEffect(() => {
		if (!index) {
			return;
		}
		// Every channel a card references, whatever shape the card is. An
		// earlier version branched on 'scatter' and left contour cards' Y out,
		// so a missing channel greyed the card while the status bar said all
		// was well; UMAP cards carry a whole list and would have repeated it.
		const refs = state.cards.flatMap((c) => {
			switch (c.kind) {
				case 'histogram':
					return [c.x.channel];
				// colorBy is deliberately absent: a missing colour channel does
				// not grey out a UMAP, it falls back to density and says so on
				// the card. Reporting it would raise a chip that tells the user
				// their card is greyed out when it is not.
				case 'umap':
					return c.channels;
				default:
					return [c.x.channel, c.y.channel];
			}
		});
		const report = summariseMapping(refs, index, manual);
		dispatch({
			type: 'setMapping',
			mapping: report.unresolved.length || report.approximate.length
				? { unresolved: report.unresolved, approximate: report.approximate }
				: undefined,
		});
	}, [index, state.cards, manual, dispatch]);

	if (state.status === 'error' && !state.data) {
		return (
			<div className="fullscreen">
				<h1>Could not open this file</h1>
				<p>{state.error?.message}</p>
			</div>
		);
	}

	return (
		<div className="app">
			<AppHeader
				data={state.data}
				workspaceName={state.workspaceName}
				sampleN={state.sampleN}
				pendingSampleN={state.pendingSampleN}
				compensate={state.compensate}
				maxSliceBytes={state.maxSliceBytes}
				confirmedBytes={confirmedBytes}
				onConfirmTransfer={setConfirmedBytes}
			/>
			<div
				className="app-body"
				// The width rides a CSS variable rather than an inline width on
				// the sidebar, so the drag can update it on the container
				// without going through React on every pointer move.
				style={{ '--samples-w': `${state.layout.samplesWidth}px` } as React.CSSProperties}
			>
				<SamplesSidebar samples={state.samples} activeId={state.activeId} loading={state.status === 'loading'} />
				<Resizer
					panel="before"
					cssVar="--samples-w"
					width={state.layout.samplesWidth}
					limits={SAMPLES_LIMITS}
					onCommit={(px) => dispatch({ type: 'setLayout', patch: { samplesWidth: px } })}
					label="Samples sidebar width"
				/>
				<main className="app-main">
					<TabBar active={state.activeTab} />
					{!state.data ? (
						<EmptyState samples={state.samples} />
					) : (
						<>
							{/* Plots stays mounted so canvases survive tab switches. */}
							<div className="view" hidden={state.activeTab !== 'plots'}>
								<PlotsView />
							</div>
							{state.activeTab === 'table' && (
								<div className="view"><DataTableView /></div>
							)}
							{state.activeTab === 'overview' && (
								<div className="view"><OverviewView data={state.data} compensate={state.compensate} /></div>
							)}
						</>
					)}
				</main>
			</div>
			<StatusBar
				status={state.status}
				error={state.error}
				mapping={state.mapping}
				warnings={state.warnings}
				pendingSampleN={state.pendingSampleN}
				sampledCount={state.data?.sampledCount}
				eventCount={state.data?.eventCount}
				compensate={state.compensate}
				canCompensate={state.data?.canCompensate}
				fileName={state.data?.fileName}
			/>
		</div>
	);
}
