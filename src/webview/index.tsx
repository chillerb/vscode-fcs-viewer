import { createRoot } from 'react-dom/client';
import './theme/theme.css';
import { AppStateProvider } from './state/AppStateContext';
import { App } from './App';
import { postToHost } from './vscodeApi';

window.addEventListener('error', (e) => {
	postToHost({ type: 'webview/error', message: e.message, ...(e.error?.stack ? { stack: String(e.error.stack) } : {}) });
});
window.addEventListener('unhandledrejection', (e) => {
	postToHost({ type: 'webview/error', message: `Unhandled rejection: ${String(e.reason)}` });
});

// No StrictMode: its double-invoked effects would double-post webview/ready
// and double-allocate canvases.
createRoot(document.getElementById('root')!).render(
	<AppStateProvider>
		<App />
	</AppStateProvider>,
);
