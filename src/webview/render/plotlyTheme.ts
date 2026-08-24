import type { Config, Layout } from 'plotly.js';
import type { ThemeColors } from '../theme/useThemeColors';

/** Plotly cannot read CSS variables, so the theme is projected into a layout. */
export function baseLayout(colors: ThemeColors, compact: boolean): Partial<Layout> {
	const axis = {
		color: colors.dim,
		gridcolor: colors.gridLine,
		zerolinecolor: colors.gridLine,
		linecolor: colors.axisLine,
		tickfont: { size: compact ? 9 : 11, color: colors.dim, family: colors.fontFamily },
		titlefont: { size: compact ? 10 : 12, color: colors.dim, family: colors.fontFamily },
		automargin: true,
		ticks: 'outside' as const,
		tickangle: 0,
		nticks: 0,
		showline: true,
		zeroline: false,
	};
	return {
		paper_bgcolor: colors.plotBackground,
		plot_bgcolor: colors.plotBackground,
		font: { family: colors.fontFamily, color: colors.foreground, size: compact ? 10 : 12 },
		margin: compact ? { l: 52, r: 12, t: 8, b: 40 } : { l: 66, r: 20, t: 16, b: 54 },
		showlegend: false,
		hovermode: 'closest',
		hoverlabel: {
			bgcolor: colors.plotBackground,
			bordercolor: colors.axisLine,
			font: { family: colors.fontFamily, color: colors.foreground, size: 11 },
		},
		dragmode: 'pan',
		xaxis: { ...axis },
		yaxis: { ...axis },
	};
}

export function baseConfig(fileName: string, scrollZoom = true): Partial<Config> {
	return {
		displaylogo: false,
		responsive: false,
		// Wheel-zoom with pan as the default drag: the interaction cytometry
		// users expect from gating tools. Disabled on the SVG fallback path,
		// where every wheel tick would rebuild thousands of paths.
		scrollZoom,
		doubleClick: 'reset',
		modeBarButtonsToRemove: ['select2d', 'lasso2d', 'autoScale2d', 'toggleSpikelines'],
		toImageButtonOptions: { format: 'png', filename: fileName, scale: 2 },
	};
}
