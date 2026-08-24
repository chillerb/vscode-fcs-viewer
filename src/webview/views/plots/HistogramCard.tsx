import { useCallback, useMemo } from 'react';
import { inverse } from '../../../common/fcs/transform';
import type { HistogramCardConfig } from '../../state/appReducer';
import type { CardRenderProps } from './PlotCard';
import { PlotlyChart } from './PlotlyChart';
import type { PlotData } from '../../render/plotly';
import { baseConfig, baseLayout } from '../../render/plotlyTheme';
import { useThemeColors } from '../../theme/useThemeColors';
import { useDispatch } from '../../state/AppStateContext';
import { toRawDomain, useAxisPlan, useResolvedAxis } from './useCardScales';
import { MissingChannel, PlotBadges } from './PlotChrome';

/**
 * sqrt(n), clamped. Chosen over Freedman-Diaconis, which needs an IQR in
 * transformed space and, against a large spike of zeros, collapses that IQR
 * and explodes the bin count into the thousands.
 */
export function autoBinCount(n: number): number {
	return Math.max(32, Math.min(256, Math.round(Math.sqrt(Math.max(1, n)))));
}

export function HistogramCard(props: CardRenderProps & { config: HistogramCardConfig }): React.ReactElement {
	const { config, data, index, manual, compensate, indices, enlarged } = props;
	const extentPx = enlarged ? 900 : 400;
	const colors = useThemeColors();
	const dispatch = useDispatch();

	const xAxis = useResolvedAxis(config.x, data, index, manual, compensate);
	const xPlan = useAxisPlan(config.x, xAxis, indices, extentPx);

	const binned = useMemo(() => {
		if (!xPlan) {
			return undefined;
		}
		const bins = config.binCount === 'auto' ? autoBinCount(indices.length) : config.binCount;
		const [t0, t1] = xPlan.tDomain;
		const span = t1 - t0 || 1;
		// Binning happens in transformed space over the axis domain, so bars are
		// uniform on screen. Binning a log axis in linear space gives useless bars.
		const counts = new Float64Array(bins);
		let total = 0;
		let offScale = 0;
		for (let i = 0; i < xPlan.transformed.length; i++) {
			const t = xPlan.transformed[i]!;
			if (Number.isNaN(t)) {
				continue;
			}
			const f = (t - t0) / span;
			if (f < 0 || f > 1) {
				offScale++;
				continue;
			}
			counts[Math.min(bins - 1, (f * bins) | 0)]!++;
			total++;
		}
		const binWidth = span / bins;
		const centres = new Float64Array(bins);
		const edges = new Float64Array(bins + 1);
		for (let b = 0; b <= bins; b++) {
			edges[b] = t0 + b * binWidth;
		}
		for (let b = 0; b < bins; b++) {
			centres[b] = t0 + (b + 0.5) * binWidth;
		}
		let max = 0;
		for (const c of counts) {
			if (c > max) {
				max = c;
			}
		}
		const values = new Float64Array(bins);
		for (let b = 0; b < bins; b++) {
			const c = counts[b]!;
			values[b] = config.yScale === 'percent' ? (max > 0 ? (100 * c) / max : 0)
				: config.yScale === 'density' ? (total > 0 ? c / (total * binWidth) : 0)
					: c;
		}
		return { counts, values, centres, edges, bins, total, offScale, binWidth };
	}, [xPlan, config.binCount, config.yScale, indices.length]);

	const traces = useMemo((): Array<Partial<PlotData>> => {
		if (!binned || !xPlan) {
			return [];
		}
		// Drawn as a step-shaped scatter rather than a bar trace: it is the
		// EasyFlowQ/FlowJo idiom, stays readable when distributions are overlaid,
		// and keeps `bar` out of the gl2d bundle.
		const x: number[] = [];
		const y: number[] = [];
		for (let b = 0; b < binned.bins; b++) {
			x.push(binned.edges[b]!, binned.edges[b + 1]!);
			y.push(binned.values[b]!, binned.values[b]!);
		}
		const raw = binned.centres.map((t) => inverse(t, xPlan.spec));
		return [{
			type: 'scatter',
			mode: 'lines',
			x,
			y,
			line: { color: colors.series, width: config.style === 'bars' ? 1 : 1.5, shape: 'linear' },
			...(config.style === 'filled' || config.style === 'bars'
				? { fill: 'tozeroy' as const, fillcolor: colors.seriesTranslucent }
				: {}),
			hoverinfo: 'skip',
		}, {
			// An invisible marker trace carries the hover readout, so hovering
			// reports the bin centre in raw units and the bin's count.
			type: 'scatter',
			mode: 'markers',
			x: binned.centres as unknown as number[],
			y: binned.values as unknown as number[],
			marker: { size: 1, opacity: 0 },
			customdata: Array.from(binned.counts, (c, i) => [raw[i]!, c]) as unknown as PlotData['customdata'],
			hovertemplate: `${xAxis.label}: %{customdata[0]:.4~g}<br>count: %{customdata[1]:,d}<extra></extra>`,
		}];
	}, [binned, xPlan, colors, config.style, xAxis.label]);

	const layout = useMemo(() => {
		const base = baseLayout(colors, !enlarged);
		const yTitle = config.yScale === 'percent' ? '% of max' : config.yScale === 'density' ? 'density' : 'count';
		return {
			...base,
			xaxis: {
				...base.xaxis,
				title: { text: xAxis.label },
				range: xPlan?.tDomain,
				tickvals: xPlan?.tickvals,
				ticktext: xPlan?.ticktext,
			},
			// The count axis is always linear and always starts at zero.
			yaxis: { ...base.yaxis, title: { text: yTitle }, rangemode: 'tozero' as const },
		};
	}, [colors, enlarged, xAxis.label, xPlan, config.yScale]);

	const chartConfig = useMemo(() => baseConfig(`${data.fileName}-${config.id}`), [data.fileName, config.id]);

	const onRelayout = useCallback(
		(r: { x?: [number, number]; reset: boolean }) => {
			if (r.reset) {
				dispatch({ type: 'updateAxis', id: config.id, axis: 'x', patch: { domain: 'auto' } });
				return;
			}
			if (r.x && xPlan) {
				dispatch({ type: 'updateAxis', id: config.id, axis: 'x', patch: { domain: toRawDomain(r.x, xPlan.spec) } });
			}
		},
		[dispatch, config.id, xPlan],
	);

	if (!xAxis.values) {
		return <MissingChannel names={[xAxis.ref.name]} />;
	}

	return (
		<div className="plot-frame">
			<PlotlyChart traces={traces} layout={layout} config={chartConfig} onRelayout={onRelayout} />
			<PlotBadges
				hidden={xPlan?.undefinedCount ?? 0}
				zoomed={config.x.domain !== 'auto'}
				onReset={() => onRelayout({ reset: true })}
			/>
		</div>
	);
}
