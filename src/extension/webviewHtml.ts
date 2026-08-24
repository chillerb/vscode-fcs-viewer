import * as vscode from 'vscode';
import { randomBytes } from 'node:crypto';

/**
 * A CSP nonce has to come from a CSPRNG, not Math.random(). The exposure here
 * is small -- the webview loads one local script and default-src is 'none' --
 * but a predictable nonce is a predictable nonce.
 */
function getNonce(): string {
	return randomBytes(16).toString('base64');
}

export function getWebviewHtml(webview: vscode.Webview, extensionUri: vscode.Uri): string {
	const nonce = getNonce();
	const dist = vscode.Uri.joinPath(extensionUri, 'dist');
	const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(dist, 'webview.js'));
	const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(dist, 'webview.css'));

	// style-src needs 'unsafe-inline' because grid spans, virtualisation
	// offsets and the SVG axis overlay all set inline style attributes, which
	// CSP blocks otherwise. Scripts stay nonce-locked. connect-src is 'none'
	// because everything arrives over postMessage; blob: in img-src costs
	// nothing and keeps a future PNG export from needing a CSP change.
	const csp = [
		`default-src 'none'`,
		`img-src ${webview.cspSource} data: blob:`,
		`style-src ${webview.cspSource} 'unsafe-inline'`,
		`script-src 'nonce-${nonce}'`,
		`font-src ${webview.cspSource}`,
		`connect-src 'none'`,
	].join('; ');

	return `<!DOCTYPE html>
<html lang="en">
<head>
	<meta charset="UTF-8">
	<meta http-equiv="Content-Security-Policy" content="${csp}">
	<meta name="viewport" content="width=device-width, initial-scale=1.0">
	<link rel="stylesheet" href="${styleUri}">
	<title>FCS Viewer</title>
</head>
<body>
	<div id="root"></div>
	<script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
}
