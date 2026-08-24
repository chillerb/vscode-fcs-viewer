import * as vscode from 'vscode';

let channel: vscode.LogOutputChannel | undefined;

export function getLogger(): vscode.LogOutputChannel {
	if (!channel) {
		channel = vscode.window.createOutputChannel('FCS Viewer', { log: true });
	}
	return channel;
}

export function disposeLogger(): void {
	channel?.dispose();
	channel = undefined;
}
