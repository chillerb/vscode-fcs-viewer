/**
 * Serialises file opens across every entry point.
 *
 * Dragging five files calls the redirect provider five times, and the explorer
 * commands can fire several more. Unserialised that stacks five progress
 * notifications, races the registry's id counter, thrashes the shared matrix
 * cache, and leaves "which sample is active" down to whichever parse finished
 * last.
 *
 * Lives here rather than in the custom-editor provider, which is only where
 * the problem was first hit: extension.ts routes seven commands through it, so
 * it is extension-wide infrastructure and not part of the redirect editor.
 */
let queue: Promise<unknown> = Promise.resolve();

export function enqueue<T>(fn: () => Promise<T>): Promise<T> {
	const next = queue.then(fn, fn);
	queue = next.catch(() => undefined);
	return next;
}
