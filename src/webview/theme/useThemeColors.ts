import { useEffect, useState } from 'react';

export interface ThemeColors {
	isDark: boolean;
	isHighContrast: boolean;
	foreground: string;
	dim: string;
	gridLine: string;
	axisLine: string;
	series: string;
	seriesTranslucent: string;
	plotBackground: string;
	plotBackgroundRgb: [number, number, number];
	fontFamily: string;
}

function read(name: string, fallback: string): string {
	const v = getComputedStyle(document.body).getPropertyValue(name).trim();
	return v === '' ? fallback : v;
}

function toRgb(css: string): [number, number, number] {
	const probe = document.createElement('span');
	probe.style.color = css;
	document.body.appendChild(probe);
	const resolved = getComputedStyle(probe).color;
	probe.remove();
	const m = /rgba?\((\d+)[,\s]+(\d+)[,\s]+(\d+)/.exec(resolved);
	return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : [30, 30, 30];
}

function readAll(): ThemeColors {
	const cls = document.body.className;
	const isHighContrast = cls.includes('vscode-high-contrast');
	const isDark = cls.includes('vscode-dark') || (isHighContrast && !cls.includes('high-contrast-light'));
	const plotBackground = read('--fcs-card-bg', isDark ? '#252526' : '#f3f3f3');
	const series = read('--fcs-series', '#3794ff');
	return {
		isDark,
		isHighContrast,
		foreground: read('--fcs-plot-fg', isDark ? '#ccc' : '#333'),
		dim: read('--fcs-fg-dim', '#888'),
		gridLine: read('--fcs-plot-line', isDark ? '#454545' : '#ddd'),
		axisLine: read('--fcs-border', isDark ? '#555' : '#ccc'),
		series,
		seriesTranslucent: `color-mix(in srgb, ${series} 70%, transparent)`,
		plotBackground,
		plotBackgroundRgb: toRgb(plotBackground),
		fontFamily: read('--fcs-font', 'sans-serif'),
	};
}

/**
 * Canvas cannot use CSS variables, so colours are read out and cached.
 * VS Code rewrites the whole --vscode-* block on the body's style attribute
 * when the theme changes, so both class and style are observed, debounced
 * because a single theme switch fires several mutations.
 */
export function useThemeColors(): ThemeColors {
	const [colors, setColors] = useState<ThemeColors>(() => readAll());

	useEffect(() => {
		let timer: number | undefined;
		const observer = new MutationObserver(() => {
			if (timer !== undefined) {
				clearTimeout(timer);
			}
			timer = window.setTimeout(() => setColors(readAll()), 50);
		});
		observer.observe(document.body, { attributes: true, attributeFilter: ['class', 'style'] });
		return () => {
			observer.disconnect();
			if (timer !== undefined) {
				clearTimeout(timer);
			}
		};
	}, []);

	return colors;
}
