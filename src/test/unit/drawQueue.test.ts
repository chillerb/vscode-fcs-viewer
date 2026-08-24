import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { cancelDraw, enqueueDraw, pendingDraws, resetDrawQueue } from '../../webview/render/drawQueue';

/**
 * The queue exists so a grid of cards paints one card per frame instead of
 * blocking the window until the last one is drawn. Measured on eight cards
 * with WebGL unavailable: a single 398 ms task became seven tasks of at most
 * 64 ms.
 *
 * requestAnimationFrame is stubbed as a macrotask, which is enough to exercise
 * the ordering and coalescing without a browser.
 */
const frames: Array<() => void> = [];
function flush(): void {
	// Each turn runs the frame callbacks queued so far; the queue schedules the
	// next draw from inside one, so this has to loop rather than iterate once.
	for (let guard = 0; guard < 100 && frames.length > 0; guard++) {
		frames.splice(0, frames.length).forEach((fn) => fn());
	}
}

beforeEach(() => {
	// The queue is module state shared by every card, so a test that leaves
	// something queued would otherwise wedge the next one.
	resetDrawQueue();
	frames.length = 0;
	// The real one defers to after paint via a nested setTimeout; collapsing
	// both hops into one synchronous callback keeps the test deterministic.
	(globalThis as { requestAnimationFrame?: unknown }).requestAnimationFrame = (fn: () => void) => {
		frames.push(() => fn());
		return frames.length;
	};
	(globalThis as { setTimeout?: unknown }).setTimeout = (fn: () => void) => {
		frames.push(fn);
		return 0;
	};
});

describe('drawQueue', () => {
	it('runs nothing synchronously', () => {
		let ran = false;
		enqueueDraw({}, () => {
			ran = true;
		});
		assert.equal(ran, false, 'the whole point is to get out of the current task');
		assert.equal(pendingDraws(), 1);
	});

	it('drains every queued draw, in the order they were queued', () => {
		const order: number[] = [];
		for (const i of [1, 2, 3]) {
			enqueueDraw({}, () => {
				order.push(i);
			});
		}
		flush();
		assert.deepEqual(order, [1, 2, 3]);
		assert.equal(pendingDraws(), 0);
	});

	it('keeps only the latest draw for a given key', () => {
		const key = {};
		const ran: string[] = [];
		enqueueDraw(key, () => {
			ran.push('stale');
		});
		enqueueDraw(key, () => {
			ran.push('fresh');
		});
		assert.equal(pendingDraws(), 1);
		flush();
		assert.deepEqual(ran, ['fresh'], 'a card that re-rendered must not draw twice');
	});

	it('drops a cancelled draw, for a card that unmounted', () => {
		const gone = {};
		const ran: string[] = [];
		enqueueDraw(gone, () => {
			ran.push('gone');
		});
		enqueueDraw({}, () => {
			ran.push('kept');
		});
		cancelDraw(gone);
		flush();
		assert.deepEqual(ran, ['kept']);
	});

	it('keeps going after a draw throws', () => {
		const ran: string[] = [];
		enqueueDraw({}, () => {
			throw new Error('plotly exploded');
		});
		enqueueDraw({}, () => {
			ran.push('after');
		});
		flush();
		assert.deepEqual(ran, ['after'], 'one failed card must not stall every card behind it');
	});

	it('waits for an async draw before starting the next', async () => {
		const ran: string[] = [];
		let release = (): void => undefined;
		const blocked = new Promise<void>((r) => {
			release = r;
		});
		enqueueDraw({}, async () => {
			ran.push('first');
			await blocked;
		});
		enqueueDraw({}, () => {
			ran.push('second');
		});

		flush();
		assert.deepEqual(ran, ['first'], 'the second draw must not start mid-flight');
		release();
		// The queue reschedules from a .then chain, so several microtask turns
		// have to drain before the next frame is even queued. setTimeout is
		// stubbed here, so this cannot just await a timer.
		for (let i = 0; i < 8; i++) {
			await Promise.resolve();
		}
		flush();
		assert.deepEqual(ran, ['first', 'second']);
	});
});
