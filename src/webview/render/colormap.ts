import type { ColormapName } from '../state/appReducer';

/**
 * Colormap stops, sampled from the matplotlib/d3 ramps.
 *
 * These are baked in rather than pulled from d3-scale-chromatic: Plotly takes
 * a colorscale as a short list of stops and interpolates the rest itself, so
 * twelve colours per map is the entire requirement -- a whole dependency for
 * 36 hex strings was not a trade worth keeping. The values are exactly
 * d3.interpolateViridis(i/11) and friends, so plots stay comparable with
 * anything else drawn from the same ramps.
 *
 * The colormaps stay theme-independent on purpose: viridis is a scientific
 * convention, and recolouring per theme would make screenshots incomparable.
 * Theme adaptation happens through marker opacity instead.
 */
const RAMPS: Record<Exclude<ColormapName, 'mono'>, readonly string[]> = {
	viridis: ['#440154', '#482173', '#433e85', '#38588c', '#2d708e', '#25858e', '#1e9b8a', '#2ab07f', '#52c569', '#86d549', '#c2df23', '#fde725'],
	inferno: ['#000004', '#140b34', '#390963', '#5f136e', '#85216b', '#a92e5e', '#cb4149', '#e65d2f', '#f78410', '#fcae12', '#f5db4c', '#fcffa4'],
	turbo: ['#23171b', '#4a51d4', '#3491f8', '#25c9d5', '#3aef9a', '#71fe65', '#b8f140', '#f2cb2c', '#ff9220', '#ed5215', '#b41d07', '#900c00'],
};

const STOPS = 12;
const cache = new Map<string, Array<[number, string]>>();

/** Plotly colorscales as [position, colour] stops. */
export function plotlyColorscale(name: ColormapName, accent: string): Array<[number, string]> {
	const key = name === 'mono' ? `mono:${accent}` : name;
	const cached = cache.get(key);
	if (cached) {
		return cached;
	}
	const scale: Array<[number, string]> = [];
	for (let i = 0; i < STOPS; i++) {
		const t = i / (STOPS - 1);
		scale.push([t, name === 'mono' ? mix(accent, t) : RAMPS[name][i]!]);
	}
	cache.set(key, scale);
	return scale;
}

/** Fade a single hue toward transparency at the low-density end. */
function mix(color: string, t: number): string {
	const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(color.trim());
	const [r, g, b] = m
		? [parseInt(m[1]!, 16), parseInt(m[2]!, 16), parseInt(m[3]!, 16)]
		: [55, 148, 255];
	const k = 0.35 + 0.65 * t;
	return `rgb(${Math.round(r * k)},${Math.round(g * k)},${Math.round(b * k)})`;
}
