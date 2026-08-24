import { useSyncExternalStore } from 'react';

/**
 * Whether Plotly's scattergl can actually work in this window.
 *
 * VS Code webviews do not always have WebGL: Electron blacklists the GPU on
 * plenty of Linux and remote setups, and hardware acceleration can be turned
 * off outright. When that happens scattergl renders a white "WebGL is not
 * supported" box, and each failed context attempt blocks the renderer on a
 * synchronous GPU-channel IPC, so a grid of cards stalls for tens of seconds.
 *
 * The probe deliberately mirrors what regl asks for. A looser check reports
 * success and leaves the user staring at the white box anyway.
 */

/**
 * scattergl passes these to regl as *required* extensions; a context missing
 * either one fails the whole trace even though it was created successfully.
 */
const REQUIRED_EXTENSIONS = ['ANGLE_instanced_arrays', 'OES_element_index_uint'] as const;

let cached: boolean | undefined;
const listeners = new Set<() => void>();

function probe(): boolean {
	let canvas: HTMLCanvasElement | undefined;
	let gl: WebGLRenderingContext | null = null;
	try {
		canvas = document.createElement('canvas');
		// A probe context still counts against the browser's live-context cap,
		// so keep the backing store trivial and release it in the finally.
		canvas.width = 1;
		canvas.height = 1;

		// regl only ever asks for these two -- never webgl2 -- so probing
		// webgl2 would be a false positive.
		for (const name of ['webgl', 'experimental-webgl'] as const) {
			try {
				// getContext can throw rather than return null in a hardened or
				// GPU-crashed renderer.
				gl = canvas.getContext(name) as WebGLRenderingContext | null;
			} catch {
				gl = null;
			}
			if (gl) {
				break;
			}
		}
		if (!gl) {
			return false;
		}
		// A context can come back already dead while the GPU process restarts;
		// some drivers lie about isContextLost, hence the second check.
		if (gl.isContextLost() || gl.getParameter(gl.VERSION) === null) {
			return false;
		}
		return REQUIRED_EXTENSIONS.every((ext) => gl!.getExtension(ext) !== null);
	} catch {
		return false;
	} finally {
		// Chromium caps live contexts around 16 and evicts the oldest, so a
		// leaked probe context could blank a real plot. loseContext is the only
		// way to release one deterministically.
		try {
			gl?.getExtension('WEBGL_lose_context')?.loseContext();
		} catch {
			// Nothing useful to do; the canvas is dropped either way.
		}
		if (canvas) {
			canvas.width = 0;
			canvas.height = 0;
		}
	}
}

/** Cached: the answer cannot change without a webview reload. */
export function hasWebGL(): boolean {
	return (cached ??= probe());
}

/**
 * Downgrade for the rest of the session. Called when a gl plot demonstrably
 * failed despite the probe passing -- the live-context cap and drivers that
 * only die at shader compile are both invisible to it.
 */
export function disableWebGL(): void {
	if (cached === false) {
		return;
	}
	cached = false;
	for (const l of listeners) {
		l();
	}
}

function subscribe(onChange: () => void): () => void {
	listeners.add(onChange);
	return () => listeners.delete(onChange);
}

export function useWebGL(): boolean {
	return useSyncExternalStore(subscribe, hasWebGL);
}
