import { pauseDraws } from './drawQueue';

/**
 * The two things that have to happen while a sidebar splitter is dragged, and
 * the one that has to happen when it stops.
 *
 * Resizing the sidebar reflows the plot grid on every frame, and the browser
 * re-lays out every plot's DOM with it: six cards cost about 125 ms a frame,
 * which is a visibly laggy drag. So for the length of the gesture the cards'
 * contents are skipped (`content-visibility`, see PlotsView.css) and draws are
 * paused, and the plots catch up afterwards.
 *
 * The flush is explicit rather than left to each chart's ResizeObserver,
 * because a `content-visibility: hidden` subtree does not deliver resize
 * observations -- and Chromium does not deliver the ones it missed when the
 * subtree comes back. Relying on the observer left every plot rendered at its
 * pre-drag width until something else happened to resize it.
 */

const DRAGGING_CLASS = 'layout-dragging';

const flushers = new Set<() => void>();

/** Register work to run once a layout drag ends. Returns an unsubscribe. */
export function onLayoutSettled(fn: () => void): () => void {
	flushers.add(fn);
	return () => flushers.delete(fn);
}

export function beginLayoutDrag(): void {
	document.body.classList.add(DRAGGING_CLASS);
	pauseDraws(true);
}

export function endLayoutDrag(): void {
	// Contents first: the flushed jobs have to measure the real layout, not the
	// skipped one.
	document.body.classList.remove(DRAGGING_CLASS);
	pauseDraws(false);
	for (const flush of flushers) {
		flush();
	}
}
