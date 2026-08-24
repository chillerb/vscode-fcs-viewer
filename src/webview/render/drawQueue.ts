/**
 * Serialises plot draws so a grid of cards paints progressively.
 *
 * When a sample arrives, every visible card re-renders in the same React
 * commit and each one calls Plotly.react from its effect. Those effects run
 * back to back in a single task, so the browser cannot paint or handle input
 * until the last card is done -- six cards at roughly 150 ms each is the
 * second-long freeze that looks like the data is still loading, when in fact
 * it arrived long ago.
 *
 * Running one draw per frame turns that into cards appearing one after
 * another, with the window responsive throughout. Total time is slightly
 * worse; perceived time is far better, because the first plot is on screen in
 * a frame or two and scrolling never locks up.
 *
 * Jobs are keyed by their element, so a card that re-renders while queued
 * replaces its pending draw instead of drawing twice.
 */
type Job = () => void | Promise<void>;

const pending = new Map<object, Job>();
let scheduled = false;

/**
 * Yield to the browser between draws.
 *
 * requestAnimationFrame alone is not enough: a callback that runs there is
 * still inside the frame, so a heavy draw delays the very paint it was
 * supposed to follow. Waiting for the frame and then falling through to a
 * task puts the work after the paint, which is what actually keeps the window
 * responsive.
 *
 * Exported because the UMAP fit needs exactly the same yield between slices of
 * work; a second copy of this reasoning would be a second thing to get wrong.
 */
export function afterPaint(fn: () => void): void {
	// Read off globalThis at call time rather than closing over the DOM global:
	// this module is also compiled for the node test build, which has no
	// requestAnimationFrame, and reading it late is what lets a test stub it.
	const raf = (globalThis as { requestAnimationFrame?: (cb: () => void) => unknown }).requestAnimationFrame;
	if (raf) {
		raf(() => setTimeout(fn, 0));
		return;
	}
	setTimeout(fn, 0);
}

function pump(): void {
	scheduled = false;
	const next = pending.entries().next();
	if (next.done) {
		return;
	}
	const [key, job] = next.value;
	pending.delete(key);
	try {
		const result = job();
		if (result instanceof Promise) {
			void result.catch(() => undefined).then(() => schedule());
			return;
		}
	} catch {
		// A failed draw must not stall every card behind it.
	}
	schedule();
}

function schedule(): void {
	if (scheduled || paused || pending.size === 0) {
		return;
	}
	scheduled = true;
	afterPaint(pump);
}

let paused = false;
let watchdog: ReturnType<typeof setTimeout> | undefined;

/**
 * Hold every draw until the gesture ends.
 *
 * Dragging a sidebar splitter resizes each visible card on every frame, and
 * Plotly.Plots.resize on a WebGL trace costs tens of milliseconds -- six cards
 * turned a 300 ms drag into seconds of long tasks. Because jobs are keyed,
 * pausing collapses a whole drag into one final draw per card: the plots hold
 * their last size while the layout follows the pointer, then catch up one per
 * frame the way they do after a sample switch.
 *
 * The watchdog exists because a pause that is never lifted would freeze every
 * plot in the panel. A lost pointerup should be impossible -- pointer capture
 * plus a pointercancel handler -- but "impossible" is not a good enough reason
 * to make it unrecoverable.
 */
export function pauseDraws(on: boolean): void {
	paused = on;
	clearTimeout(watchdog);
	watchdog = undefined;
	if (on) {
		watchdog = setTimeout(() => pauseDraws(false), 5000);
		return;
	}
	schedule();
}

/** Queue a draw for `key`, replacing any draw still queued for it. */
export function enqueueDraw(key: object, job: Job): void {
	pending.set(key, job);
	schedule();
}

/** Drop a queued draw, for a card that is unmounting. */
export function cancelDraw(key: object): void {
	pending.delete(key);
}

/** Test hook. */
export function pendingDraws(): number {
	return pending.size;
}

/** Test hook: this module holds process-wide state, so tests must reset it. */
export function resetDrawQueue(): void {
	pending.clear();
	scheduled = false;
	pauseDraws(false);
}
