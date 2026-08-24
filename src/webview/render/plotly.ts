// A custom Plotly bundle rather than one of the prebuilt dist files, because
// no prebuilt file has the traces this viewer needs: plotly-gl2d has scattergl
// but no contour, plotly-cartesian has contour but no WebGL. Assembling from
// lib/core costs one build-time alias -- scattergl reaches typedarray-pool,
// which wants node's Buffer -- and comes out slightly SMALLER than the gl2d
// bundle it replaces, since nothing else in core-plus-three-traces is pulled
// in. `bar` stays out: histograms are drawn as step-shaped scatter traces,
// which matches the cytometry idiom anyway.
import Plotly from 'plotly.js/lib/core';
import scattergl from 'plotly.js/lib/scattergl';
import histogram2dcontour from 'plotly.js/lib/histogram2dcontour';
import type { Config, Layout, PlotData } from 'plotly.js';

Plotly.register([scattergl, histogram2dcontour]);

export type { Config, Layout, PlotData };
export default Plotly as unknown as typeof import('plotly.js');

/**
 * scattergl is one WebGL context per plot and browsers evict beyond roughly 16
 * live contexts, which blanks older plots. A card grid can exceed that, so the
 * SVG path is used below this threshold and off-screen cards are purged.
 *
 * Density colouring makes the SVG path noticeably more expensive -- Plotly has
 * to style each point node individually -- and routing density plots to WebGL
 * at any size was measured at 87 ms of blocking against 33 ms over eight
 * cards. That was not worth spending a WebGL context per card to buy, given
 * that running out of contexts blanks plots outright.
 */
export const GL_THRESHOLD = 6_000;

/**
 * Point cap when WebGL is unavailable and scatter falls back to SVG.
 *
 * Plotly's SVG scatter emits one <path> per point, so 10,000 per card is
 * 0.7-1.5s of DOM construction and unusable wheel-zoom. 5,000 is the value that
 * renders comfortably.
 */
export const SVG_POINT_CAP = 5_000;
