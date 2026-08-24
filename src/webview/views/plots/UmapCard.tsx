import { useMemo } from 'react';
import { UMAP_MAX_CELLS, type UmapCardConfig } from '../../state/appReducer';
import type { CardRenderProps } from './PlotCard';
import { PlotlyChart } from './PlotlyChart';
import { GL_THRESHOLD, type PlotData } from '../../render/plotly';
import { useWebGL } from '../../render/webgl';
import { baseConfig, baseLayout } from '../../render/plotlyTheme';
import { plotlyColorscale } from '../../render/colormap';
import { pointDensity } from '../../render/density';
import { useThemeColors } from '../../theme/useThemeColors';
import { resolveChannel } from '../../state/channelResolver';
import { useUmapEmbedding, type EmbeddingRequest } from '../../state/useUmapEmbedding';
import { forward } from '../../../common/fcs/transform';
import { defaultSpecFor } from '../../compute/embedding';
import { MissingChannel } from './PlotChrome';

/** Above this many markers, wheel zoom on the SVG path starts to feel heavy. */
const SVG_SCROLL_LIMIT = 4000;

/**
 * A UMAP of several channels.
 *
 * The axes are not data: UMAP coordinates have no units and their absolute
 * values mean nothing, so they are drawn without ticks. Distances between
 * clusters are not meaningful either, which is why nothing here offers a
 * transform or a range control.
 */
export function UmapCard(props: CardRenderProps & { config: UmapCardConfig }): React.ReactElement {
	const { config, data, index, manual, compensate, enlarged, indices, cofactor } = props;
	const colors = useThemeColors();
	const glOk = useWebGL();

	// Every projection channel has to resolve. A UMAP computed over a
	// different feature set than the one configured would be quietly wrong
	// rather than visibly broken, so a missing channel refuses outright.
	const resolved = useMemo(
		() => config.channels.map((ref) => ({ ref, channel: resolveChannel(ref, index, manual).channel })),
		[config.channels, index, manual],
	);
	const missing = resolved.filter((r) => !r.channel).map((r) => r.ref.name);

	const request = useMemo((): EmbeddingRequest | undefined => {
		if (missing.length > 0 || resolved.length < 2) {
			return undefined;
		}
		return {
			sampleId: data.id,
			// A prefix of the rows every other card is drawing right now --
			// not of the slice the host sent. Lowering the global subsample
			// does not shrink the slice, so `data.rows(n)` would happily hand
			// back cells no other card is showing.
			rows: indices.subarray(0, Math.min(config.cells, UMAP_MAX_CELLS, indices.length)),
			channels: resolved.map((r) => ({
				index: r.channel!.index,
				values: data.column(r.channel!.index, compensate),
				kind: r.channel!.kind,
				cofactor,
			})),
			nNeighbors: config.nNeighbors,
			minDist: config.minDist,
			compensate,
			seed: data.seed,
		};
		// `missing` is derived from `resolved`; listing both would not change when.
	}, [data, indices, resolved, missing.length, config.cells, config.nNeighbors, config.minDist, compensate, cofactor]);

	const embedding = useUmapEmbedding(request);
	const xy = embedding.status === 'done'
		? embedding.result.xy
		: embedding.status === 'running' ? embedding.partial.xy : undefined;

	// Colour is applied here, over coordinates that are already computed --
	// which is the whole reason the embedding signature ignores it.
	const colorChannel = config.colorBy ? resolveChannel(config.colorBy, index, manual).channel : undefined;
	const rows = request?.rows;

	const traces = useMemo((): Array<Partial<PlotData>> => {
		if (!xy || !rows) {
			return [];
		}
		const n = rows.length;
		const x = new Float64Array(n);
		const y = new Float64Array(n);
		for (let i = 0; i < n; i++) {
			x[i] = xy[i * 2]!;
			y[i] = xy[i * 2 + 1]!;
		}

		let color: Float64Array;
		let cmin = 0;
		let cmax = 1;
		if (colorChannel) {
			// Coloured on the transformed scale, the same one the axes use.
			// Raw intensities are heavily skewed -- a marker positive in 3% of
			// cells leaves every other cell in the bottom colour and the plot
			// reads as empty.
			const values = data.column(colorChannel.index, compensate);
			const spec = defaultSpecFor(colorChannel.kind, cofactor);
			color = new Float64Array(n);
			for (let i = 0; i < n; i++) {
				const v = forward(values[rows[i]!]!, spec);
				color[i] = Number.isFinite(v) ? v : 0;
			}
			// Percentile clipping, so one bright outlier does not flatten the
			// scale the way a raw min/max would.
			const sorted = Float64Array.from(color).sort();
			cmin = sorted[Math.floor(n * 0.01)] ?? 0;
			cmax = sorted[Math.floor(n * 0.99)] ?? 1;
			if (!(cmax > cmin)) {
				cmax = cmin + 1;
			}
		} else {
			// No domain: UMAP has no axis range to match, and spreading the
			// coordinates into Math.min would tie correctness to how many
			// cells the card is allowed to embed.
			color = pointDensity(x, y);
		}

		return [{
			type: glOk && n > GL_THRESHOLD ? 'scattergl' : 'scatter',
			mode: 'markers',
			x: x as unknown as number[],
			y: y as unknown as number[],
			marker: {
				size: config.pointSize * 2,
				color: color as unknown as number[],
				colorscale: plotlyColorscale(config.colormap, colors.series),
				cmin,
				cmax,
				opacity: colors.isHighContrast ? 1 : 0.8,
			},
			hoverinfo: 'skip',
		}];
	}, [xy, rows, colorChannel, data, compensate, cofactor, config.pointSize, config.colormap, colors, glOk]);

	const layout = useMemo(() => {
		const base = baseLayout(colors, !enlarged);
		// UMAP coordinates are arbitrary; ticks would invite reading them.
		const axis = { showticklabels: false, zeroline: false, showgrid: false, ticks: '' as const };
		return {
			...base,
			xaxis: { ...base.xaxis, ...axis, title: { text: 'UMAP 1' } },
			yaxis: { ...base.yaxis, ...axis, title: { text: 'UMAP 2' } },
		};
	}, [colors, enlarged]);

	const chartConfig = useMemo(() => {
		const n = rows?.length ?? 0;
		// Wheel zoom was off here only because the other SVG path (contour)
		// rebuilds thousands of filled paths per tick. A UMAP is a few thousand
		// markers, which SVG re-renders fine, so it gets the same interaction
		// as a scatter card.
		const base = baseConfig(`${data.fileName}-${config.id}`, glOk || n <= SVG_SCROLL_LIMIT);
		return {
			...base,
			// UMAP has no meaningful home range to reset to, so both the
			// double click and the mode bar button mean "fit the points".
			doubleClick: 'autosize' as const,
			modeBarButtonsToRemove: (base.modeBarButtonsToRemove ?? []).filter((b) => b !== 'autoScale2d'),
		};
	}, [data.fileName, config.id, glOk, rows]);

	if (missing.length > 0) {
		return <MissingChannel names={missing} />;
	}
	if (resolved.length < 2) {
		return <div className="plot-missing dim">Pick at least two channels to project in the inspector.</div>;
	}

	return (
		<div className="plot-frame">
			<PlotlyChart traces={traces} layout={layout} config={chartConfig} isGl={glOk && (rows?.length ?? 0) > GL_THRESHOLD} />
			{config.colorBy !== undefined && colorChannel === undefined && (
				// Colouring by a channel this sample does not have falls back to
				// density, which looks like a working plot of something else.
				<div className="umap-progress">
					No <span className="mono">{config.colorBy.label ?? config.colorBy.name}</span> in this sample — coloured by density.
				</div>
			)}
			{embedding.status !== 'done' && (
				<div className="umap-progress">
					{embedding.status === 'preparing' && 'Building the neighbour graph…'}
					{embedding.status === 'running' && `Embedding… ${Math.round((embedding.epoch / embedding.total) * 100)}%`}
					{embedding.status === 'failed' && `UMAP failed: ${embedding.message}`}
				</div>
			)}
		</div>
	);
}
