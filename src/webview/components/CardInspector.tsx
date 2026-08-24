import React, { memo } from 'react';
import type { TransformKind } from '../../common/fcs/transform';
import { logParamsFor } from '../render/scales';
import { UMAP_MAX_CELLS, type AxisConfig, type CardConfig, type CardSpan, type ColormapName } from '../state/appReducer';
import type { SampleData } from '../state/SampleData';
import type { ChannelRef, ResolverIndex } from '../state/channelResolver';
import { colorChoices, projectionRows, resolveChannel } from '../state/channelResolver';
import { useDispatch } from '../state/AppStateContext';
import { ChannelPicker } from './ui/ChannelPicker';
import { NumberField } from './ui/NumberField';
import './CardInspector.css';

interface Props {
	card: CardConfig | undefined;
	data: SampleData;
	index: ResolverIndex;
	manual: Map<string, number>;
	compensate: boolean;
	/** The rows being plotted, so derived flog parameters match the plot. */
	indices: Uint32Array;
}

const COLORMAPS: Array<{ id: ColormapName; label: string }> = [
	{ id: 'viridis', label: 'Viridis' },
	{ id: 'inferno', label: 'Inferno' },
	{ id: 'turbo', label: 'Turbo' },
	{ id: 'mono', label: 'Monochrome' },
];

const KINDS: Array<{ id: CardConfig['kind']; label: string }> = [
	{ id: 'scatter', label: 'Scatter' },
	{ id: 'contour', label: 'Contour' },
	{ id: 'histogram', label: 'Histogram' },
	{ id: 'umap', label: 'UMAP' },
];

/** Offered embedding sizes. Only those within the global subsample are shown. */
const UMAP_CELL_OPTIONS = [500, 1000, 2000, 5000];

const TRANSFORMS: Array<{ id: TransformKind; label: string }> = [
	{ id: 'linear', label: 'Linear' },
	{ id: 'log', label: 'Log' },
	{ id: 'arsinh', label: 'Arsinh' },
];

/**
 * Editing happens here rather than inside each card, so the tiles stay compact
 * and scannable and the controls are built once. The cost is a selection
 * model, which the card's focus ring makes visible.
 */
export const CardInspector = memo(function CardInspector({ card, data, index, manual, compensate, indices }: Props) {
	const dispatch = useDispatch();

	if (!card) {
		return (
			<aside className="inspector">
				<div className="inspector-head">Inspector</div>
				<p className="dim inspector-empty">Select a plot card to edit it.</p>
			</aside>
		);
	}

	const axisEditor = (which: 'x' | 'y', axis: AxisConfig): React.ReactElement => {
		const resolved = resolveChannel(axis.channel, index, manual);
		// The same derivation the plot uses, so the fields never disagree with
		// the axis they describe.
		const logOf = (a: AxisConfig): { m: number; t: number } => {
			if (a.logM !== undefined && a.logT !== undefined) {
				return { m: a.logM, t: a.logT };
			}
			const derived = resolved.channel
				? logParamsFor(data.column(resolved.channel.index, compensate), indices)
				: { m: 1, t: 1 };
			return { m: a.logM ?? derived.m, t: a.logT ?? derived.t };
		};
		const patch = (p: Partial<AxisConfig>): void => dispatch({ type: 'updateAxis', id: card.id, axis: which, patch: p });
		return (
			<div className="inspector-group" key={which}>
				<ChannelPicker
					label={which === 'x' ? 'X channel' : 'Y channel'}
					channels={data.metadata.channels}
					value={axis.channel}
					resolvedIndex={resolved.channel?.index}
					onChange={(ref) => patch({ channel: ref })}
				/>
				{resolved.approximate && resolved.channel && (
					<p className="dim hint">
						Matched <span className="mono">{axis.channel.name}</span> to{' '}
						<span className="mono">{resolved.channel.name}</span> by name similarity.
					</p>
				)}
				<div className="row">
					<label className="dim">
						Transform
						<select
							value={axis.transform}
							onChange={(e) => patch({ transform: e.target.value as TransformKind })}
						>
							{TRANSFORMS.map((t) => (
								<option key={t.id} value={t.id}>{t.label}</option>
							))}
						</select>
					</label>
				</div>

				{/* Only the parameters the chosen transform actually has. Linear
				    has none, so the group disappears entirely. */}
				{axis.transform !== 'linear' && (
					<fieldset className="params">
						<legend className="dim">Transform parameters</legend>
						{axis.transform === 'arsinh' && (
							<NumberField
								label="Cofactor"
								value={axis.cofactor}
								min={1e-6}
								onCommit={(v) => patch({ cofactor: v })}
							/>
						)}
						{axis.transform === 'log' && (
							<>
								{/* GatingML 2.0 flog: (1/M)*log10(x/T) + 1, which maps
								    [T*10^-M, T] onto [0, 1]. The fields show the values
								    in force, derived from the channel until set. */}
								<NumberField label="M (decades)" value={logOf(axis).m} min={0.1} onCommit={(v) => patch({ logM: v })} />
								{/* Wider than the default: a top of scale is routinely seven digits,
								    and 1000000 clipped to 100000 is a misreading, not a
								    cosmetic one. */}
								<NumberField label="T (top of scale)" value={logOf(axis).t} min={1e-6} width={90} onCommit={(v) => patch({ logT: v })} />
								<button
									type="button"
									className="link"
									disabled={axis.logM === undefined && axis.logT === undefined}
									title="Derive M and T from this channel's values"
									onClick={() => patch({ logM: undefined, logT: undefined })}
								>
									Auto
								</button>
								<p className="dim hint">
									Shows {logOf(axis).m} decade{logOf(axis).m === 1 ? '' : 's'} up to{' '}
									<span className="mono">{logOf(axis).t.toLocaleString()}</span>.
								</p>
							</>
						)}
					</fieldset>
				)}

				<div className="row">
					<label className="check">
						<input
							type="checkbox"
							checked={axis.domain === 'auto'}
							onChange={(e) => patch({ domain: e.target.checked ? 'auto' : [0, 1000] })}
						/>
						Auto range
					</label>
				</div>
				{axis.domain !== 'auto' && (
					<div className="row">
						<NumberField label="Min" value={axis.domain[0]} onCommit={(v) => patch({ domain: [v, (axis.domain as [number, number])[1]] })} />
						<NumberField label="Max" value={axis.domain[1]} onCommit={(v) => patch({ domain: [(axis.domain as [number, number])[0], v] })} />
					</div>
				)}
			</div>
		);
	};

	/**
	 * The projection list, which always shows the card's own channels first.
	 *
	 * A UMAP card gets looked at against several samples, and listing only what
	 * the active sample has would make a channel it lacks invisible -- not just
	 * unselectable but impossible to remove, so the card would stay stuck
	 * refusing to compute. Selected channels are therefore always listed and
	 * flagged when the active sample does not have them; the sample's remaining
	 * channels follow.
	 */
	const umapChannels = (selected: ChannelRef[]): React.ReactElement => {
		const rows = projectionRows(selected, data.metadata.channels, index, manual);
		const toggle = (ref: ChannelRef, on: boolean): void => dispatch({
			type: 'updateUmap',
			id: card.id,
			patch: {
				channels: on
					? [...selected, ref].sort((a, b) => a.index - b.index)
					: selected.filter((r) => r.name !== ref.name),
			},
		});
		const chosen = rows.filter((r) => r.on).length;
		return (
			<div className="umap-channels">
				{rows.map(({ ref, on, present }, i) => (
					<React.Fragment key={ref.name}>
						{/* Between what the card projects and what is merely on
						    offer, so a long panel does not read as one flat list. */}
						{i === chosen && chosen > 0 && <hr className="list-divider" />}
						<label
							className={`check${present ? '' : ' absent'}`}
							// Marker names run long and the list is narrow, so
							// the full text lives in the tooltip rather than
							// wrapping.
							title={present
								? [ref.label, ref.name].filter((x) => x !== undefined).join(' \u2014 ')
								: `${ref.label ?? ref.name} is not in this sample. Untick it to drop it from the projection.`}
						>
							<input type="checkbox" checked={on} onChange={(e) => toggle(ref, e.target.checked)} />
							<span className="channel-name">{ref.label ?? ref.name}</span>
							{ref.label !== undefined && <span className="dim channel-alias">{ref.name}</span>}
							{!present && <span className="dim absent-tag">not here</span>}
						</label>
					</React.Fragment>
				))}
			</div>
		);
	};

	/**
	 * Embedding sizes that make sense for this sample.
	 *
	 * The card can never embed more than the global subsample -- it takes a
	 * prefix of exactly those events -- so offering bigger numbers would
	 * promise cells that do not exist.
	 */
	const umapCellOptions = (cells: number): Array<{ value: number; label: string }> => {
		// indices, not data.sampledCount: lowering the global subsample does not
		// shrink the slice the host already sent, so sampledCount would keep
		// offering cells no other card is drawing.
		const cap = Math.min(indices.length, UMAP_MAX_CELLS);
		const values = UMAP_CELL_OPTIONS.filter((n) => n < cap);
		values.push(cap);
		const current = Math.min(cells, cap);
		if (!values.includes(current)) {
			values.push(current);
			values.sort((a, b) => a - b);
		}
		return values.map((n) => ({
			value: n,
			// "All" only when the cap really is the whole subsample; at the
			// UMAP ceiling it is not, and saying so would be a lie.
			label: n === cap && cap < UMAP_MAX_CELLS ? `All ${cap.toLocaleString()}` : n.toLocaleString(),
		}));
	};

	const umapColorSelect = (colorBy: ChannelRef | undefined): React.ReactElement => {
		const { current, available } = colorChoices(colorBy, data.metadata.channels);
		return (
			<select
				value={colorBy?.name ?? ''}
				onChange={(e) => {
					const picked = [current, ...available].find((o) => o.value === e.target.value);
					dispatch({ type: 'updateUmap', id: card.id, patch: { colorBy: picked?.ref } });
				}}
			>
				<option value={current.value}>{current.label}</option>
				{/* Chromium renders a separator for an <hr> in a <select>;
				    anywhere it does not, it is simply ignored. */}
				<hr />
				{available.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
			</select>
		);
	};

	return (
		<aside className="inspector">
			<div className="inspector-head">Inspector</div>
			<div className="inspector-body">
				<div className="inspector-group">
					<div className="row">
						<label className="dim">
							Plot type
							<select
								value={card.kind}
								onChange={(e) => dispatch({ type: 'changeCardKind', id: card.id, kind: e.target.value as CardConfig['kind'] })}
							>
								{KINDS.map((k) => (
									<option key={k.id} value={k.id}>{k.label}</option>
								))}
							</select>
						</label>
					</div>
					<div className="row">
						<span className="dim">Size</span>
						<div className="segmented" role="group">
							{([[1, 1], [2, 1], [2, 2]] as Array<[1 | 2 | 3, 1 | 2]>).map(([cols, rows]) => {
								const span: CardSpan = { cols, rows };
								const active = card.span.cols === cols && card.span.rows === rows;
								return (
									<button key={`${cols}x${rows}`} type="button" className={active ? 'active' : ''}
										onClick={() => dispatch({ type: 'updateCard', id: card.id, patch: { span } })}>
										{cols}×{rows}
									</button>
								);
							})}
						</div>
					</div>
				</div>

				{card.kind !== 'umap' && axisEditor('x', card.x)}
				{card.kind !== 'umap' && card.kind !== 'histogram' && axisEditor('y', card.y)}

				{card.kind === 'umap' && (
					<div className="inspector-group">
						<div className="row">
							<span className="dim">Projected channels</span>
						</div>
						{umapChannels(card.channels)}
						<div className="row">
							<NumberField
								label="Neighbours"
								title={"UMAP's locality parameter, and the closest thing it has to t-SNE's perplexity. Higher values favour global structure, lower ones local detail."}
								value={card.nNeighbors}
								min={2}
								onCommit={(v) => dispatch({ type: 'updateUmap', id: card.id, patch: { nNeighbors: Math.round(v) } })}
							/>
							<NumberField
								label="Min distance"
								title="How tightly points are allowed to pack together. Lower values make denser, more separated clumps."
								value={card.minDist}
								min={0}
								onCommit={(v) => dispatch({ type: 'updateUmap', id: card.id, patch: { minDist: v } })}
							/>
						</div>
						<div className="row">
							<label
								className="dim"
								title={`UMAP embeds a prefix of the same subsample every other card draws, and plots exactly those cells — at most this many, never more than the global subsample, and never above ${UMAP_MAX_CELLS.toLocaleString()}. Above 2,000 the neighbour graph takes noticeably longer to build.`}
							>Max cells
								<select
									value={Math.min(card.cells, data.sampledCount)}
									onChange={(e) => dispatch({ type: 'updateUmap', id: card.id, patch: { cells: Number(e.target.value) } })}
								>
									{umapCellOptions(card.cells).map((o) => (
										<option key={o.value} value={o.value}>{o.label}</option>
									))}
								</select>
							</label>
							<label className="dim">Colormap
								<select
									value={card.colormap}
									onChange={(e) => dispatch({ type: 'updateUmap', id: card.id, patch: { colormap: e.target.value as ColormapName } })}
								>
									{COLORMAPS.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}
								</select>
							</label>
						</div>
						<div className="row">
							<label className="dim" title="Changing the colour reuses the embedding; it does not recompute.">Colour by
								{umapColorSelect(card.colorBy)}
							</label>
						</div>
					</div>
				)}

				{card.kind === 'contour' && (
					<div className="inspector-group">
						<div className="row">
							<label className="dim">Colormap
								<select
									value={card.colormap}
									onChange={(e) => dispatch({ type: 'updateContour', id: card.id, patch: { colormap: e.target.value as ColormapName } })}
								>
									{COLORMAPS.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}
								</select>
							</label>
							<label className="dim">Levels
								<select
									value={card.levels}
									onChange={(e) => dispatch({ type: 'updateContour', id: card.id, patch: { levels: Number(e.target.value) } })}
								>
									{[6, 8, 12, 16, 24].map((n) => <option key={n} value={n}>{n}</option>)}
								</select>
							</label>
						</div>
						<div className="row">
							<label className="dim">Shading
								<select
									value={card.coloring}
									onChange={(e) => dispatch({ type: 'updateContour', id: card.id, patch: { coloring: e.target.value as 'fill' | 'heatmap' | 'lines' } })}
								>
									<option value="fill">Filled bands</option>
									<option value="heatmap">Smooth</option>
									<option value="lines">Lines only</option>
								</select>
							</label>
						</div>
						<label className="check">
							<input
								type="checkbox"
								checked={card.showPoints}
								onChange={(e) => dispatch({ type: 'updateContour', id: card.id, patch: { showPoints: e.target.checked } })}
							/>
							Show events underneath
						</label>
					</div>
				)}

				{card.kind === 'scatter' && (
					<div className="inspector-group">
						<label className="check">
							<input
								type="checkbox"
								checked={card.density}
								onChange={(e) => dispatch({ type: 'updateScatter', id: card.id, patch: { density: e.target.checked } })}
							/>
							Density overlay
						</label>
						{card.density && (
							<div className="row">
								<label className="dim">Colormap
									<select
										value={card.colormap}
										onChange={(e) => dispatch({ type: 'updateScatter', id: card.id, patch: { colormap: e.target.value as ColormapName } })}
									>
										{COLORMAPS.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}
									</select>
								</label>
							</div>
						)}
						<div className="row">
							<label className="dim">Point size
								<select
									value={card.pointSize}
									onChange={(e) => dispatch({ type: 'updateScatter', id: card.id, patch: { pointSize: Number(e.target.value) as 1 | 2 | 3 } })}
								>
									<option value={1}>1</option>
									<option value={2}>2</option>
									<option value={3}>3</option>
								</select>
							</label>
						</div>
					</div>
				)}

				{card.kind === 'histogram' && (
					<div className="inspector-group">
						<div className="row">
							<label className="dim">Bins
								<select
									value={card.binCount === 'auto' ? 'auto' : String(card.binCount)}
									onChange={(e) => dispatch({
										type: 'updateHistogram', id: card.id,
										patch: { binCount: e.target.value === 'auto' ? 'auto' : Number(e.target.value) },
									})}
								>
									<option value="auto">Auto</option>
									{[32, 64, 128, 256].map((n) => <option key={n} value={n}>{n}</option>)}
								</select>
							</label>
							<label className="dim">Y scale
								<select
									value={card.yScale}
									onChange={(e) => dispatch({ type: 'updateHistogram', id: card.id, patch: { yScale: e.target.value as 'count' | 'percent' | 'density' } })}
								>
									<option value="count">Count</option>
									<option value="percent">% of max</option>
									<option value="density">Density</option>
								</select>
							</label>
						</div>
						<div className="row">
							<label className="dim">Style
								<select
									value={card.style}
									onChange={(e) => dispatch({ type: 'updateHistogram', id: card.id, patch: { style: e.target.value as 'bars' | 'outline' | 'filled' } })}
								>
									<option value="outline">Outline</option>
									<option value="filled">Filled</option>
									<option value="bars">Bars</option>
								</select>
							</label>
						</div>
					</div>
				)}
			</div>
		</aside>
	);
});
