import { useCallback, useMemo } from 'react';
import type { ContourCardConfig } from '../../state/appReducer';
import type { CardRenderProps } from './PlotCard';
import { PlotlyChart } from './PlotlyChart';
import type { PlotData } from '../../render/plotly';
import { baseConfig, baseLayout } from '../../render/plotlyTheme';
import { plotlyColorscale } from '../../render/colormap';
import { useThemeColors } from '../../theme/useThemeColors';
import { useDispatch } from '../../state/AppStateContext';
import { toRawDomain, useAxisPlan, useResolvedAxis } from './useCardScales';
import { MissingChannel, PlotBadges } from './PlotChrome';

/**
 * Points drawn under the contours. Enough to show where the rare events are
 * without turning an SVG trace into tens of thousands of paths -- the contours
 * are the primary reading and the points are context.
 */
const UNDERLAY_CAP = 4_000;

/**
 * A binned 2D density, drawn as contour levels.
 *
 * histogram2dcontour rather than contour: it bins the events itself, so this
 * needs the same two transformed arrays a scatter does and no grid of our own.
 * Unlike a dot plot, what it shows barely moves with the subsample size, which
 * makes it the honest choice for judging population shape.
 */
function floorTransparent(scale: Array<[number, string]>): Array<[number, string]> {
	return scale.map(([t, c], i) => [t, i === 0 ? 'rgba(0,0,0,0)' : c] as [number, string]);
}

export function ContourCard(props: CardRenderProps & { config: ContourCardConfig }): React.ReactElement {
	const { config, data, index, manual, compensate, indices, enlarged } = props;
	const extentPx = enlarged ? 900 : 400;
	const colors = useThemeColors();
	const dispatch = useDispatch();

	const xAxis = useResolvedAxis(config.x, data, index, manual, compensate);
	const yAxis = useResolvedAxis(config.y, data, index, manual, compensate);
	const xPlan = useAxisPlan(config.x, xAxis, indices, extentPx);
	const yPlan = useAxisPlan(config.y, yAxis, indices, enlarged ? 560 : 200);

	const traces = useMemo((): Array<Partial<PlotData>> => {
		if (!xPlan || !yPlan) {
			return [];
		}
		const out: Array<Partial<PlotData>> = [];

		// Underlay first so the contours draw over it.
		if (config.showPoints) {
			const n = Math.min(UNDERLAY_CAP, xPlan.transformed.length);
			out.push({
				type: 'scatter',
				mode: 'markers',
				x: xPlan.transformed.subarray(0, n) as unknown as number[],
				y: yPlan.transformed.subarray(0, n) as unknown as number[],
				marker: { size: 2, color: colors.dim, opacity: 0.4 },
				hoverinfo: 'skip',
				showlegend: false,
			});
		}

		out.push({
			type: 'histogram2dcontour' as PlotData['type'],
			x: xPlan.transformed as unknown as number[],
			y: yPlan.transformed as unknown as number[],
			// The lowest band is made transparent: filled contours otherwise
			// paint the entire panel in the colormap's darkest colour, which
			// reads as a population covering the whole plot rather than as
			// empty space.
			colorscale: floorTransparent(plotlyColorscale(config.colormap, colors.series)),
			ncontours: config.levels,
			showscale: false,
			contours: {
				coloring: config.coloring,
				showlines: config.coloring !== 'heatmap',
			},
			line: { width: config.coloring === 'lines' ? 1 : 0.5 },
			hoverinfo: 'skip',
		} as Partial<PlotData>);

		return out;
	}, [xPlan, yPlan, config.colormap, config.levels, config.coloring, config.showPoints, colors]);

	const layout = useMemo(() => {
		const base = baseLayout(colors, !enlarged);
		return {
			...base,
			xaxis: { ...base.xaxis, title: { text: xAxis.label }, range: xPlan?.tDomain, tickvals: xPlan?.tickvals, ticktext: xPlan?.ticktext },
			yaxis: { ...base.yaxis, title: { text: yAxis.label }, range: yPlan?.tDomain, tickvals: yPlan?.tickvals, ticktext: yPlan?.ticktext },
		};
	}, [colors, enlarged, xAxis.label, yAxis.label, xPlan, yPlan]);

	// Contours are SVG whatever the WebGL situation, so wheel-zoom would
	// rebuild every path on each notch.
	const chartConfig = useMemo(() => baseConfig(`${data.fileName}-${config.id}`, false), [data.fileName, config.id]);

	const onRelayout = useCallback(
		(r: { x?: [number, number]; y?: [number, number]; reset: boolean }) => {
			if (r.reset) {
				dispatch({ type: 'updateAxis', id: config.id, axis: 'x', patch: { domain: 'auto' } });
				dispatch({ type: 'updateAxis', id: config.id, axis: 'y', patch: { domain: 'auto' } });
				return;
			}
			if (r.x && xPlan) {
				dispatch({ type: 'updateAxis', id: config.id, axis: 'x', patch: { domain: toRawDomain(r.x, xPlan.spec) } });
			}
			if (r.y && yPlan) {
				dispatch({ type: 'updateAxis', id: config.id, axis: 'y', patch: { domain: toRawDomain(r.y, yPlan.spec) } });
			}
		},
		[dispatch, config.id, xPlan, yPlan],
	);

	if (!xAxis.values || !yAxis.values) {
		return <MissingChannel names={[!xAxis.values && xAxis.ref.name, !yAxis.values && yAxis.ref.name].filter(Boolean) as string[]} />;
	}

	return (
		<div className="plot-frame">
			<PlotlyChart traces={traces} layout={layout} config={chartConfig} onRelayout={onRelayout} />
			<PlotBadges
				hidden={(xPlan?.undefinedCount ?? 0) + (yPlan?.undefinedCount ?? 0)}
				zoomed={config.x.domain !== 'auto' || config.y.domain !== 'auto'}
				onReset={() => onRelayout({ reset: true })}
			/>
		</div>
	);
}
