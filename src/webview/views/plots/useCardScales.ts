import { useMemo } from 'react';
import { forward, inverse, defined, type TransformSpec } from '../../../common/fcs/transform';
import type { SampleData } from '../../state/SampleData';
import { autoDomain, logParamsFor, makeScale, type Scale } from '../../render/scales';
import { resolveChannel, type ChannelRef, type ResolverIndex } from '../../state/channelResolver';
import type { AxisConfig } from '../../state/appReducer';

export interface ResolvedAxis {
	ref: ChannelRef;
	index: number | undefined;
	label: string;
	values: Float32Array | undefined;
	approximate: boolean;
}

export function useResolvedAxis(
	axis: AxisConfig,
	data: SampleData,
	index: ResolverIndex,
	manual: Map<string, number>,
	compensate: boolean,
): ResolvedAxis {
	return useMemo(() => {
		const r = resolveChannel(axis.channel, index, manual);
		if (!r.channel) {
			return { ref: axis.channel, index: undefined, label: axis.channel.label ?? axis.channel.name, values: undefined, approximate: false };
		}
		const c = r.channel;
		return {
			ref: axis.channel,
			index: c.index,
			label: c.label !== undefined ? `${c.label} (${c.name})` : c.name,
			values: data.column(c.index, compensate),
			approximate: r.approximate,
		};
	}, [axis.channel, data, index, manual, compensate]);
}

export interface AxisPlan {
	spec: TransformSpec;
	/** The flog parameters in force, whether set explicitly or derived. */
	log: { m: number; t: number };
	/** Domain in raw data units. */
	domain: [number, number];
	/** Domain in transformed units, which is what Plotly's linear axis sees. */
	tDomain: [number, number];
	/** Transformed values for the sampled events. */
	transformed: Float64Array;
	/** Raw values for the sampled events, for hover readouts. */
	raw: Float64Array;
	tickvals: number[];
	ticktext: string[];
	/** Excluded because the transform cannot represent them (log of v <= 0). */
	undefinedCount: number;
	scale: Scale;
}

/**
 * Values are handed to Plotly already transformed, because Plotly has no
 * arsinh axis type -- only linear, log, date and category. The axis is
 * therefore linear in transformed space with explicit tick positions, which is
 * what produces the biexponential look. Raw values ride along as customdata so
 * hover reports real data units rather than transformed ones.
 */
export function useAxisPlan(
	axis: AxisConfig,
	resolved: ResolvedAxis,
	indices: Uint32Array,
	/** Approximate axis length in CSS pixels, used only to thin the ticks. */
	extentPx: number,
): AxisPlan | undefined {
	return useMemo(() => {
		const values = resolved.values;
		if (!values) {
			return undefined;
		}
		// Unset flog parameters are derived from the plotted values. They
		// cannot default to the spec's M = T = 1, which frames the axis on
		// 0.1 to 1 and hides every real measurement.
		const derived = axis.transform === 'log' && (axis.logM === undefined || axis.logT === undefined)
			? logParamsFor(values, indices)
			: undefined;
		const log = { m: axis.logM ?? derived?.m ?? 1, t: axis.logT ?? derived?.t ?? 1 };
		const spec: TransformSpec = {
			kind: axis.transform,
			cofactor: axis.cofactor,
			logM: log.m,
			logT: log.t,
		};
		const domain = axis.domain === 'auto'
			? autoDomain(values, indices, axis.transform, axis.cofactor, log)
			: axis.domain;

		const n = indices.length;
		const transformed = new Float64Array(n);
		const raw = new Float64Array(n);
		let undefinedCount = 0;
		for (let i = 0; i < n; i++) {
			const v = values[indices[i]!]!;
			raw[i] = v;
			if (!defined(v, spec)) {
				transformed[i] = NaN;
				undefinedCount++;
				continue;
			}
			transformed[i] = forward(v, spec);
		}

		// Reuse the tick machinery: 1/2/5 x 10^k candidates thinned by pixel
		// distance, always keeping zero, which is what stops an arsinh axis
		// smearing into an unreadable cluster near the origin.
		const scale = makeScale(axis.transform, axis.cofactor, domain, [0, extentPx], log);
		const tickvals: number[] = [];
		const ticktext: string[] = [];
		const fmt = scale.tickFormat();
		for (const t of scale.ticks()) {
			tickvals.push(forward(t, spec));
			ticktext.push(fmt(t));
		}

		return {
			spec,
			log,
			domain,
			tDomain: [forward(domain[0], spec), forward(domain[1], spec)],
			transformed,
			raw,
			tickvals,
			ticktext,
			undefinedCount,
			scale,
		};
	}, [axis.transform, axis.cofactor, axis.logM, axis.logT, axis.domain, resolved.values, indices, extentPx]);
}

/** Convert a Plotly axis range (transformed units) back to raw data units. */
export function toRawDomain(range: [number, number], spec: TransformSpec): [number, number] {
	return [inverse(range[0], spec), inverse(range[1], spec)];
}
