import { memo, useMemo, useState } from 'react';
import { UMAP_MAX_CELLS, type CardConfig } from '../../state/appReducer';
import type { SampleData } from '../../state/SampleData';
import type { ResolverIndex } from '../../state/channelResolver';
import { useDispatch } from '../../state/AppStateContext';
import { ScatterCard } from './ScatterCard';
import { HistogramCard } from './HistogramCard';
import { ContourCard } from './ContourCard';
import { UmapCard } from './UmapCard';

export interface CardRenderProps {
	config: CardConfig;
	data: SampleData;
	index: ResolverIndex;
	manual: Map<string, number>;
	compensate: boolean;
	/** The global subsample. Histograms bin, so they always use all of it. */
	indices: Uint32Array;
	/** Same set, capped when WebGL is unavailable and scatter falls back to SVG. */
	scatterIndices: Uint32Array;
	/** True when scatterIndices is smaller than indices. */
	capped: boolean;
	/**
	 * The global arsinh cofactor. Axis cards carry their own on the axis; UMAP
	 * has no axes, so it transforms with this one -- the same number the
	 * inspector edits, rather than a second one derived from the file.
	 */
	cofactor: number;
	enlarged?: boolean;
}

interface Props extends CardRenderProps {
	selected: boolean;
	position: number;
	onDragStart: (id: string) => void;
	onDropAt: (index: number) => void;
}

function autoTitle(config: CardConfig): string {
	const name = (ref: { label?: string; name: string }): string => ref.label ?? ref.name;
	switch (config.kind) {
		case 'histogram':
			return `${name(config.x.channel)} histogram`;
		case 'umap':
			return `UMAP of ${config.channels.length} channels`;
		default:
			return `${name(config.x.channel)} × ${name(config.y.channel)}`;
	}
}

export const KIND_LABELS: Record<CardConfig['kind'], string> = {
	scatter: 'Scatter',
	contour: 'Contour',
	umap: 'UMAP',
	histogram: 'Histogram',
};

export const PlotCard = memo(function PlotCard(props: Props) {
	const { config, selected, position, onDragStart, onDropAt } = props;
	const dispatch = useDispatch();
	const [dropSide, setDropSide] = useState<'before' | 'after' | undefined>();

	const summary = useMemo(() => {
		const parts = [KIND_LABELS[config.kind]];
		if (config.kind === 'umap') {
			// UMAP embeds fewer cells than the other cards draw, and saying so
			// is the honest way to present a plot of a different subset.
			parts.push(`${config.nNeighbors} neighbours`);
			const embedded = Math.min(config.cells, UMAP_MAX_CELLS, props.indices.length);
			parts.push(
				embedded < props.indices.length
					? `${embedded.toLocaleString()} of ${props.indices.length.toLocaleString()} events`
					: `${embedded.toLocaleString()} events`,
			);
			return parts.join(' · ');
		}
		const t = config.x.transform;
		parts.push(t === 'arsinh' ? `arsinh(${config.x.cofactor})` : t);
		// A capped scatter must not claim more events than it drew.
		const shown = config.kind === 'scatter' ? props.scatterIndices.length : props.indices.length;
		parts.push(
			shown < props.indices.length
				? `${shown.toLocaleString()} of ${props.indices.length.toLocaleString()} events`
				: `${shown.toLocaleString()} events`,
		);
		return parts.join(' · ');
	}, [config, props.indices.length, props.scatterIndices.length]);

	return (
		<section
			className={`plot-card${selected ? ' selected' : ''}${dropSide ? ` drop-${dropSide}` : ''}`}
			data-cols={config.span.cols}
			data-rows={config.span.rows}
			tabIndex={0}
			aria-selected={selected}
			onClick={() => dispatch({ type: 'selectCard', id: config.id })}
			onDoubleClick={() => dispatch({ type: 'enlargeCard', id: config.id })}
			onFocus={() => dispatch({ type: 'selectCard', id: config.id })}
			onDragOver={(e) => {
				e.preventDefault();
				const box = e.currentTarget.getBoundingClientRect();
				setDropSide(e.clientX < box.left + box.width / 2 ? 'before' : 'after');
			}}
			onDragLeave={() => setDropSide(undefined)}
			onDrop={(e) => {
				e.preventDefault();
				onDropAt(dropSide === 'after' ? position + 1 : position);
				setDropSide(undefined);
			}}
			onKeyDown={(e) => {
				if (e.altKey && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
					e.preventDefault();
					onDragStart(config.id);
					onDropAt(e.key === 'ArrowLeft' ? position - 1 : position + 2);
				}
			}}
		>
			<header
				className="plot-card-head"
				draggable
				onDragStart={() => onDragStart(config.id)}
			>
				<span className="grip" aria-hidden="true">⠿</span>
				<span className="plot-card-title">{config.title ?? autoTitle(config)}</span>
				<span className="plot-card-actions">
					<button type="button" title="Enlarge" onClick={(e) => { e.stopPropagation(); dispatch({ type: 'enlargeCard', id: config.id }); }}>⤢</button>
					<button type="button" title="Duplicate" onClick={(e) => { e.stopPropagation(); dispatch({ type: 'duplicateCard', id: config.id }); }}>⧉</button>
					<button type="button" title="Remove" onClick={(e) => { e.stopPropagation(); dispatch({ type: 'removeCard', id: config.id }); }}>×</button>
				</span>
			</header>
			<p className="plot-card-summary dim">{summary}</p>
			<div className="plot-card-body">
				{config.kind === 'scatter' && <ScatterCard {...props} config={config} />}
				{config.kind === 'contour' && <ContourCard {...props} config={config} />}
				{config.kind === 'umap' && <UmapCard {...props} config={config} />}
				{config.kind === 'histogram' && <HistogramCard {...props} config={config} />}
			</div>
		</section>
	);
});
