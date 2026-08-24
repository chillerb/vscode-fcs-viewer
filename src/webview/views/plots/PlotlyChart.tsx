import { useEffect, useRef, useState } from 'react';
import Plotly, { type Config, type Layout, type PlotData } from '../../render/plotly';
import { disableWebGL } from '../../render/webgl';
import { cancelDraw, enqueueDraw } from '../../render/drawQueue';
import { onLayoutSettled } from '../../render/layoutDrag';

interface Props {
	traces: Array<Partial<PlotData>>;
	layout: Partial<Layout>;
	config: Partial<Config>;
	/** Whether this chart uses a WebGL trace; gates the off-screen purge. */
	isGl?: boolean;
	/** Called when the user zooms or pans, in transformed axis units. */
	onRelayout?: (range: { x?: [number, number]; y?: [number, number]; reset: boolean }) => void;
}

/**
 * Thin React wrapper over Plotly.react.
 *
 * Off-screen charts are purged and rebuilt on scroll. scattergl allocates one
 * WebGL context per plot and browsers evict past roughly 16 live contexts,
 * which silently blanks the oldest plots -- a real hazard for a grid designed
 * to hold many tiles.
 */
export function PlotlyChart({ traces, layout, config, isGl = false, onRelayout }: Props): React.ReactElement {
	const hostRef = useRef<HTMLDivElement>(null);
	// Identity only: the draw queue keys jobs by object, and resizes need a key
	// distinct from the element the draws use.
	const [resizeKey] = useState(() => ({}));
	const [visible, setVisible] = useState(false);
	const drawn = useRef(false);

	useEffect(() => {
		const el = hostRef.current;
		if (!el) {
			return;
		}
		const io = new IntersectionObserver(
			(entries) => setVisible(entries[0]?.isIntersecting ?? false),
			{ rootMargin: '200px' },
		);
		io.observe(el);
		return () => io.disconnect();
	}, []);

	useEffect(() => {
		const el = hostRef.current;
		if (!el) {
			return;
		}
		if (!visible) {
			// The purge exists only to conserve WebGL contexts. With an SVG
			// trace it just turns a scroll into a full rebuild.
			if (drawn.current && isGl) {
				Plotly.purge(el);
				drawn.current = false;
			}
			return;
		}
		if (el.clientWidth === 0 || el.clientHeight === 0) {
			return;
		}
		// Queued rather than drawn inline: every card's effect runs in the same
		// task, and drawing them all there blocks paint and input until the
		// last one finishes. See drawQueue.
		enqueueDraw(el, () =>
			Plotly.react(el, traces, layout, config).then(() => {
				drawn.current = true;
				// The probe cannot see the live-context cap, or a driver that
				// only fails at shader compile. If Plotly put up its white "no
				// WebGL" box anyway, downgrade the whole session rather than
				// repeat an expensive failure on every render.
				if (isGl && el.querySelector('.no-webgl')) {
					disableWebGL();
				}
			}),
		);
		return () => cancelDraw(el);
	}, [visible, traces, layout, config, isGl]);

	useEffect(() => {
		const el = hostRef.current;
		if (!el || !onRelayout) {
			return;
		}
		const handler = (e: Record<string, unknown>): void => {
			const reset = e['xaxis.autorange'] === true || e['yaxis.autorange'] === true;
			const x0 = e['xaxis.range[0]'];
			const x1 = e['xaxis.range[1]'];
			const y0 = e['yaxis.range[0]'];
			const y1 = e['yaxis.range[1]'];
			onRelayout({
				...(typeof x0 === 'number' && typeof x1 === 'number' ? { x: [x0, x1] as [number, number] } : {}),
				...(typeof y0 === 'number' && typeof y1 === 'number' ? { y: [y0, y1] as [number, number] } : {}),
				reset,
			});
		};
		const node = el as unknown as { on?: (ev: string, fn: (e: Record<string, unknown>) => void) => void; removeAllListeners?: (ev: string) => void };
		node.on?.('plotly_relayout', handler);
		return () => node.removeAllListeners?.('plotly_relayout');
	}, [onRelayout, visible]);

	// Plotly needs an explicit resize call; responsive:true attaches a window
	// listener per plot, which does not help when only one card is resized.
	useEffect(() => {
		const el = hostRef.current;
		if (!el) {
			return;
		}
		const resize = (): void => {
			// Plotly throws "Resize must be passed a displayed plot div element"
			// if the div was purged, or is hidden -- which happens whenever the
			// Plots tab is switched away from or a card loses its channels.
			if (!drawn.current || !isLivePlot(el)) {
				return;
			}
			// Queued for the same reason draws are: dragging a sidebar splitter
			// fires this on every visible card every frame, and running them
			// all inline is the freeze drawQueue exists to prevent. Keyed on a
			// token of its own rather than on `el`, so a queued resize can
			// never replace a queued Plotly.react and swallow new data.
			enqueueDraw(resizeKey, () => {
				if (drawn.current && isLivePlot(el)) {
					Plotly.Plots.resize(el);
				}
			});
		};
		const ro = new ResizeObserver(resize);
		ro.observe(el);
		// A sidebar drag hides these subtrees, and a hidden subtree delivers no
		// resize observations -- not even the one it missed, when it comes
		// back. So the gesture says when it is over. See layoutDrag.
		const off = onLayoutSettled(resize);
		return () => {
			ro.disconnect();
			off();
			cancelDraw(resizeKey);
		};
	}, [resizeKey]);

	useEffect(() => {
		const el = hostRef.current;
		return () => {
			if (!el) {
				return;
			}
			cancelDraw(el);
			if (drawn.current) {
				Plotly.purge(el);
			}
		};
	}, []);

	return <div ref={hostRef} className="plotly-host" />;
}

/** True only when Plotly still owns this node and it is actually laid out. */
function isLivePlot(el: HTMLElement): boolean {
	return (
		(el as { _fullLayout?: unknown })._fullLayout !== undefined &&
		el.offsetParent !== null &&
		el.clientWidth > 0 &&
		el.clientHeight > 0
	);
}
