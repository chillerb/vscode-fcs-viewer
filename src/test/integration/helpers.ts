import * as assert from 'assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { makeFcs } from '../unit/fixtures/makeFcs';

/**
 * Shared scaffolding for the integration suites.
 *
 * The polling helper below was copy-pasted byte-identically into three suites
 * and open-coded a fourth time, which is why every suite carries a 60 s
 * timeout. One copy is enough.
 */

/**
 * This extension, found by the half of its id that is not a deployment
 * decision.
 *
 * The suites used to hardcode `undefined_publisher.vscode-fcs-viewer`, so
 * setting a real publisher in the manifest broke two tests that have nothing
 * to do with publishing. The name is what identifies the extension under test.
 */
export function thisExtension(): vscode.Extension<unknown> | undefined {
	return vscode.extensions.all.find((e) => e.id.endsWith('.vscode-fcs-viewer'));
}

export interface DebugSample {
	id: string;
	fileName: string;
	eventCount: number;
	channelCount: number;
	error?: string;
}

export interface DebugPanel {
	panelId: string;
	ready: boolean;
	activeId?: string;
	samples: DebugSample[];
	resident: string[];
	pinned: string[];
	acks: Array<{ sampleId: string; eventCount: number; sampledCount: number; channelCount: number }>;
	uiCards?: number;
}

export interface DebugState {
	panelCount: number;
	focusedId?: string;
	persisted: Record<string, { updatedAt: number; activeId?: string; samples: Array<{ id: string; uri: string; fileName: string }> }>;
	panels: DebugPanel[];
	ready: boolean;
	activeId?: string;
	samples: DebugSample[];
	acks: Array<{ sampleId: string; eventCount: number; sampledCount: number; channelCount: number }>;
}

export function debugState(): Thenable<DebugState> {
	return vscode.commands.executeCommand('fcsViewer.debugState') as Thenable<DebugState>;
}

/** Poll until `predicate` holds, failing the test with `what` if it never does. */
export async function until(
	what: string,
	predicate: () => boolean | Promise<boolean>,
	timeoutMs = 20_000,
): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		if (await predicate()) {
			return;
		}
		if (Date.now() > deadline) {
			assert.fail(`timed out waiting for: ${what}`);
		}
		await new Promise((r) => setTimeout(r, 100));
	}
}

/** The focused panel, or a failure naming what was expected instead. */
export async function panel(): Promise<DebugPanel> {
	const state = await debugState();
	const p = state.panels.find((x) => x.panelId === state.focusedId) ?? state.panels[0];
	assert.ok(p, 'expected a viewer panel to be open');
	return p;
}

/** A temp directory that lives for the whole test run. */
export function tempDir(prefix: string): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/**
 * A file big enough that reading it takes measurably longer than a tiny one.
 *
 * Needed to reproduce an ordering race: with two small files both reads finish
 * in the same tick and the interleaving never happens.
 */
export function writeBigFcs(dir: string, name: string, events = 120_000): vscode.Uri {
	const file = path.join(dir, name);
	const channels = Array.from({ length: 8 }, (_, i) => ({ name: `P${i + 1}-A`, bits: 32, range: 1024 }));
	const rows = Array.from({ length: events }, (_, e) => channels.map((_c, i) => (e * 8 + i) % 1024));
	fs.writeFileSync(file, makeFcs({ channels, events: rows }));
	return vscode.Uri.file(file);
}

/** A small, valid two-channel FCS file on disk. */
export function writeFcs(dir: string, name: string, opts: { events?: number[][] } = {}): vscode.Uri {
	const file = path.join(dir, name);
	fs.writeFileSync(file, makeFcs({
		channels: [
			{ name: 'FSC-A', bits: 32, range: 1024 },
			{ name: 'B515-A', label: 'cd3', bits: 32, range: 1024 },
		],
		events: opts.events ?? [[1, 2], [3, 4], [5, 6]],
		extraKeywords: { $CYT: 'LSRII' },
	}));
	return vscode.Uri.file(file);
}
