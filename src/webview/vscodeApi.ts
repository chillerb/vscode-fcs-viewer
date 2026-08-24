import type { WebviewToHost } from '../common/protocol';

// acquireVsCodeApi() may be called exactly once per webview context; a second
// call throws. Hence the module-level singleton, and hence no StrictMode.
const api = acquireVsCodeApi();

export function postToHost(message: WebviewToHost): void {
	api.postMessage(message);
}

export function getPersistedState<T>(): T | undefined {
	return api.getState() as T | undefined;
}

/**
 * setState is the webview's own memory, which only it can read back. The same
 * blob goes to the host as well, because a named viewer workspace has to be
 * saved from the extension side and cannot ask the webview for it.
 */
export function setPersistedState<T>(state: T): void {
	api.setState(state);
	postToHost({ type: 'webview/persistState', state });
}

export function log(level: 'debug' | 'info' | 'warn' | 'error', message: string): void {
	postToHost({ type: 'webview/log', level, message });
}
