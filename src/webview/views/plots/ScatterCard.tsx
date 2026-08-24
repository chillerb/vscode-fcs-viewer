import { useCallback, useMemo } from 'react';
import type { ScatterCardConfig } from '../../state/appReducer';
import type { CardRenderProps } from './PlotCard';
import { PlotlyChart } from './PlotlyChart';
import { GL_THRESHOLD, type PlotData } from '../../render/plotly';
import { useWebGL } from '../../render/webgl';
import { baseConfig, baseLayout } from '../../render/plotlyTheme';
import { plotlyColorscale } from '../../render/colormap';
import { pointDensity } from '../../render/density';
import { useThemeColors } from '../../theme/useThemeColors';
import { useDispatch } from '../../state/AppStateContext';
import { toRawDomain, useAxisPlan, useResolvedAxis } from './useCardScales';
import { MissingChannel, PlotBadges } from './PlotChrome';

/** Above this, per-point hover data costs more than the readout is worth. */
const HOVER_LIMIT = 25_000;

export function ScatterCard(props: CardRenderProps & { config: ScatterCardConfig }): React.ReactElement {
	const { config, data, index, manual, compensate, scatterIndices: indices, enlarged } = props;
	const extentPx = enlarged ? 900 : 400;
	const glOk = useWebGL();
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
		const density = config.density
			? pointDensity(xPlan.transformed, yPlan.transformed, xPlan.tDomain, yPlan.tDomain)
			: undefined;

		// Typed arrays are passed straight through: Plotly accepts them for
		// data_array fields, which avoids a full copy per render and keeps the
		// reference stable so Plotly.react can skip recalculating.
		const marker: Partial<PlotData>['marker'] = density
			? {
				size: config.pointSize * 2,
				color: density as unknown as number[],
				colorscale: plotlyColorscale(config.colormap, colors.series),
				cmin: 0,
				cmax: 1,
				opacity: colors.isHighContrast ? 1 : 0.75,
			}
			: { size: config.pointSize * 2, color: colors.series, opacity: colors.isHighContrast ? 1 : 0.55 };

		// customdata is one small array per point, which is the heaviest
		// allocation on this path. Hovering a cloud this large is not useful
		// anyway, so above the threshold the readout is dropped instead.
		const withHover = indices.length <= HOVER_LIMIT;

		return [{
			type: glOk && indices.length > GL_THRESHOLD ? 'scattergl' : 'scatter',
			mode: 'markers',
			x: xPlan.transformed as unknown as number[],
			y: yPlan.transformed as unknown as number[],
			marker,
			...(withHover
				? {
					// The axis carries transformed values, so hover reads from
					// the raw pair instead -- which is what the user cares about.
					customdata: Array.from(xPlan.raw, (v, i) => [v, yPlan.raw[i]!]) as unknown as PlotData['customdata'],
					hovertemplate: `${xAxis.label}: %{customdata[0]:.4~g}<br>${yAxis.label}: %{customdata[1]:.4~g}<extra></extra>`,
				}
				: { hoverinfo: 'skip' as const }),
		}];
	}, [xPlan, yPlan, config.density, config.pointSize, config.colormap, colors, indices, glOk, xAxis.label, yAxis.label]);

	const layout = useMemo(() => {
		const base = baseLayout(colors, !enlarged);
		return {
			...base,
			xaxis: {
				...base.xaxis,
				title: { text: xAxis.label },
				range: xPlan?.tDomain,
				tickvals: xPlan?.tickvals,
				ticktext: xPlan?.ticktext,
			},
			yaxis: {
				...base.yaxis,
				title: { text: yAxis.label },
				range: yPlan?.tDomain,
				tickvals: yPlan?.tickvals,
				ticktext: yPlan?.ticktext,
			},
		};
	}, [colors, enlarged, xAxis.label, yAxis.label, xPlan, yPlan]);

	// Wheel-zoom rebuilds every SVG path, so it is only affordable on the
	// hardware-accelerated path.
	const chartConfig = useMemo(
		() => baseConfig(`${data.fileName}-${config.id}`, glOk),
		[data.fileName, config.id, glOk],
	);

	// Zoom and pan are just writes to the axis domain, which is already card
	// state, so they survive re-renders and sample switches.
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

	const isGl = glOk && indices.length > GL_THRESHOLD;
	return (
		<div className="plot-frame">
			<PlotlyChart traces={traces} layout={layout} config={chartConfig} onRelayout={onRelayout} isGl={isGl} />
			<PlotBadges
				hidden={(xPlan?.undefinedCount ?? 0) + (yPlan?.undefinedCount ?? 0)}
				zoomed={config.x.domain !== 'auto' || config.y.domain !== 'auto'}
				capped={props.capped ? { shown: indices.length, total: props.indices.length } : undefined}
				onReset={() => onRelayout({ reset: true })}
			/>
		</div>
	);
}
