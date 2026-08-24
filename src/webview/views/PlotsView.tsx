import { useCallback, useEffect, useMemo, useRef } from 'react';
import { useAppState, useDispatch } from '../state/AppStateContext';
import { buildIndex } from '../state/channelResolver';
import { PlotCard } from './plots/PlotCard';
import { ScatterCard } from './plots/ScatterCard';
import { HistogramCard } from './plots/HistogramCard';
import { ContourCard } from './plots/ContourCard';
import { UmapCard } from './plots/UmapCard';
import { KIND_LABELS } from './plots/PlotCard';
import { CardInspector } from '../components/CardInspector';
import { Resizer } from '../components/ui/Resizer';
import { INSPECTOR_LIMITS } from '../state/layout';
import { SVG_POINT_CAP } from '../render/plotly';
import { useWebGL } from '../render/webgl';
import './PlotsView.css';

export function PlotsView(): React.ReactElement | null {
	const state = useAppState();
	const dispatch = useDispatch();
	const dragged = useRef<string | undefined>(undefined);

	const data = state.data;
	const index = useMemo(() => (data ? buildIndex(data.metadata) : undefined), [data]);
	const manual = useMemo(() => new Map(Object.entries(state.manualMapping)), [state.manualMapping]);
	const glOk = useWebGL();
	const indices = useMemo(() => data?.rows(state.sampleN), [data, state.sampleN]);
	/**
	 * Scatter falls back to SVG without WebGL, which cannot carry the full
	 * subsample, so those cards draw a prefix.
	 *
	 * A prefix is a valid smaller sample because rows arrive in permutation
	 * order: taking the first k is exactly what asking for k events would have
	 * produced. Every card takes the same prefix, so they stay comparable.
	 */
	const scatterIndices = useMemo(() => {
		if (!data || !indices || glOk) {
			return indices;
		}
		return indices.length <= SVG_POINT_CAP ? indices : data.rows(SVG_POINT_CAP);
	}, [data, indices, glOk]);

	const onDragStart = useCallback((id: string) => {
		dragged.current = id;
	}, []);
	const onDropAt = useCallback((toIndex: number) => {
		if (dragged.current !== undefined) {
			dispatch({ type: 'moveCard', id: dragged.current, toIndex });
			dragged.current = undefined;
		}
	}, [dispatch]);

	const enlarged = state.cards.find((c) => c.id === state.enlargedCardId);

	// Escape closes the overlay; arrows move between cards while enlarged.
	useEffect(() => {
		if (!enlarged) {
			return;
		}
		const onKey = (e: KeyboardEvent): void => {
			if (e.key === 'Escape') {
				dispatch({ type: 'enlargeCard', id: undefined });
				return;
			}
			if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') {
				return;
			}
			const i = state.cards.findIndex((c) => c.id === enlarged.id);
			const next = (i + (e.key === 'ArrowRight' ? 1 : state.cards.length - 1)) % state.cards.length;
			dispatch({ type: 'enlargeCard', id: state.cards[next]!.id });
		};
		window.addEventListener('keydown', onKey);
		return () => window.removeEventListener('keydown', onKey);
	}, [enlarged, state.cards, dispatch]);

	if (!data || !index || !indices || !scatterIndices) {
		return null;
	}

	const shared = {
		data,
		index,
		manual,
		compensate: state.compensate,
		indices,
		scatterIndices,
		capped: scatterIndices.length < indices.length,
		cofactor: state.defaults.cofactor,
	};

	return (
		<div
			className="plots-view"
			style={{ '--inspector-w': `${state.layout.inspectorWidth}px` } as React.CSSProperties}
		>
			<div className="plot-grid-scroll">
				{state.cards.length === 0 ? (
					<button
						type="button"
						className="plot-card add-card plots-empty"
						onClick={() => dispatch({ type: 'addCard', kind: 'scatter' })}
					>
						<span aria-hidden="true">+</span>
						<span>Add your first plot</span>
					</button>
				) : (
					<div className="plot-grid">
						{state.cards.map((card, i) => (
							<PlotCard
								key={card.id}
								{...shared}
								config={card}
								selected={card.id === state.selectedCardId}
								position={i}
								onDragStart={onDragStart}
								onDropAt={onDropAt}
							/>
						))}
						<button
							type="button"
							className="plot-card add-card"
							title="Add a plot"
							onClick={() => dispatch({ type: 'addCard', kind: 'scatter' })}
						>
							<span aria-hidden="true">+</span>
							<span>Add plot</span>
						</button>
					</div>
				)}
			</div>

			<Resizer
				panel="after"
				cssVar="--inspector-w"
				width={state.layout.inspectorWidth}
				limits={INSPECTOR_LIMITS}
				onCommit={(px) => dispatch({ type: 'setLayout', patch: { inspectorWidth: px } })}
				label="Inspector width"
			/>
			<CardInspector
				card={state.cards.find((c) => c.id === state.selectedCardId)}
				data={data}
				index={index}
				manual={manual}
				compensate={state.compensate}
				indices={indices}
			/>

			{enlarged && (
				<div className="card-modal-backdrop" onClick={() => dispatch({ type: 'enlargeCard', id: undefined })}>
					<div className="card-modal" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="Enlarged plot">
						<header>
							<strong>{enlarged.title ?? KIND_LABELS[enlarged.kind]}</strong>
							<button type="button" onClick={() => dispatch({ type: 'enlargeCard', id: undefined })} title="Close (Escape)">×</button>
						</header>
						<div className="card-modal-body">
							{/* Rendered fresh at the larger size: the plot is a pure
							    function of config, data and size, so nothing needs moving. */}
							{enlarged.kind === 'scatter' && <ScatterCard {...shared} config={enlarged} enlarged />}
							{enlarged.kind === 'contour' && <ContourCard {...shared} config={enlarged} enlarged />}
							{enlarged.kind === 'umap' && <UmapCard {...shared} config={enlarged} enlarged />}
							{enlarged.kind === 'histogram' && <HistogramCard {...shared} config={enlarged} enlarged />}
						</div>
					</div>
				</div>
			)}
		</div>
	);
}
