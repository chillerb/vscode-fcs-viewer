import type * as vscode from 'vscode';

export const SESSIONS_KEY = 'fcsViewer.sessions';

/** How many tabs' sample lists to remember. Bounds growth without needing to
 *  detect panel closure, which VS Code gives no reliable signal for. */
export const MAX_SESSIONS = 8;

export interface PersistedSample {
	id: string;
	uri: string;
	fileName: string;
	eventCount: number;
	channelCount: number;
	cytometer?: string;
}

export interface PersistedSession {
	updatedAt: number;
	activeId?: string;
	samples: PersistedSample[];
}

export interface PersistedSessionsV1 {
	version: 1;
	sessions: Record<string, PersistedSession>;
}

function isSample(v: unknown): v is PersistedSample {
	if (typeof v !== 'object' || v === null) {
		return false;
	}
	const s = v as Partial<PersistedSample>;
	return (
		typeof s.id === 'string' &&
		typeof s.uri === 'string' &&
		typeof s.fileName === 'string' &&
		typeof s.eventCount === 'number' &&
		typeof s.channelCount === 'number'
	);
}

/**
 * Read the persisted sessions. Never throws: this runs inside
 * deserializeWebviewPanel, where an exception would leave a dead tab, so
 * anything unrecognised is discarded rather than reported.
 */
export function loadSessions(context: vscode.ExtensionContext): PersistedSessionsV1 {
	const empty: PersistedSessionsV1 = { version: 1, sessions: {} };
	const raw = context.workspaceState.get<unknown>(SESSIONS_KEY);
	if (typeof raw !== 'object' || raw === null) {
		return empty;
	}
	const rec = raw as Partial<PersistedSessionsV1>;
	if (rec.version !== 1 || typeof rec.sessions !== 'object' || rec.sessions === null) {
		return empty;
	}

	const sessions: Record<string, PersistedSession> = {};
	for (const [panelId, value] of Object.entries(rec.sessions)) {
		if (typeof value !== 'object' || value === null) {
			continue;
		}
		const s = value as Partial<PersistedSession>;
		const samples = Array.isArray(s.samples) ? s.samples.filter(isSample) : [];
		sessions[panelId] = {
			updatedAt: typeof s.updatedAt === 'number' ? s.updatedAt : 0,
			samples,
			...(typeof s.activeId === 'string' ? { activeId: s.activeId } : {}),
		};
	}
	return { version: 1, sessions };
}

export function loadSession(context: vscode.ExtensionContext, panelId: string): PersistedSession | undefined {
	return loadSessions(context).sessions[panelId];
}

export async function saveSession(
	context: vscode.ExtensionContext,
	panelId: string,
	session: Omit<PersistedSession, 'updatedAt'>,
): Promise<void> {
	const all = loadSessions(context);
	all.sessions[panelId] = { ...session, updatedAt: Date.now() };
	await context.workspaceState.update(SESSIONS_KEY, prune(all));
}

export async function deleteSession(context: vscode.ExtensionContext, panelId: string): Promise<void> {
	const all = loadSessions(context);
	if (!(panelId in all.sessions)) {
		return;
	}
	delete all.sessions[panelId];
	await context.workspaceState.update(SESSIONS_KEY, all);
}

/**
 * Discard the automatic per-tab memory. Named workspaces are deliberately left
 * alone: they were saved on purpose, and losing them to a command about
 * "remembered samples" would be a nasty surprise.
 */
export async function clearWorkspace(context: vscode.ExtensionContext): Promise<void> {
	await context.workspaceState.update(SESSIONS_KEY, undefined);
}

/** Keep only the most recently updated sessions. */
export function prune(all: PersistedSessionsV1, max = MAX_SESSIONS): PersistedSessionsV1 {
	const entries = Object.entries(all.sessions);
	if (entries.length <= max) {
		return all;
	}
	entries.sort((a, b) => b[1].updatedAt - a[1].updatedAt);
	return { version: 1, sessions: Object.fromEntries(entries.slice(0, max)) };
}

export async function pruneStored(context: vscode.ExtensionContext): Promise<void> {
	const all = loadSessions(context);
	const pruned = prune(all);
	if (Object.keys(pruned.sessions).length !== Object.keys(all.sessions).length) {
		await context.workspaceState.update(SESSIONS_KEY, pruned);
	}
}

/**
 * A named viewer workspace: the samples a tab holds plus the card layout that
 * was built on them.
 *
 * Distinct from a PersistedSession, which is the automatic per-tab memory that
 * survives a window reload and gets pruned. These are explicit, keyed by a
 * name the user chose, and never pruned -- deleting one is a deliberate act.
 * They live in workspaceState rather than globalState because the samples are
 * file paths, which only mean something inside the folder they were opened in.
 */
export const WORKSPACES_KEY = 'fcsViewer.namedWorkspaces';

export interface NamedWorkspace {
	name: string;
	savedAt: number;
	activeId?: string;
	samples: PersistedSample[];
	/** The webview's own persisted UI blob: cards, table columns, subsample. */
	ui?: unknown;
}

export interface NamedWorkspacesV1 {
	version: 1;
	items: NamedWorkspace[];
}

/** Never throws: a corrupt entry is dropped rather than blocking the command. */
export function loadWorkspaces(context: vscode.ExtensionContext): NamedWorkspace[] {
	const raw = context.workspaceState.get<unknown>(WORKSPACES_KEY);
	if (typeof raw !== 'object' || raw === null) {
		return [];
	}
	const rec = raw as Partial<NamedWorkspacesV1>;
	if (rec.version !== 1 || !Array.isArray(rec.items)) {
		return [];
	}
	const out: NamedWorkspace[] = [];
	for (const value of rec.items) {
		if (typeof value !== 'object' || value === null) {
			continue;
		}
		const w = value as Partial<NamedWorkspace>;
		if (typeof w.name !== 'string' || w.name === '' || !Array.isArray(w.samples)) {
			continue;
		}
		out.push({
			name: w.name,
			savedAt: typeof w.savedAt === 'number' ? w.savedAt : 0,
			samples: w.samples.filter(isSample),
			...(typeof w.activeId === 'string' ? { activeId: w.activeId } : {}),
			...(w.ui !== undefined ? { ui: w.ui } : {}),
		});
	}
	return out.sort((a, b) => b.savedAt - a.savedAt);
}

/** Saving under an existing name replaces it, which is what "save" means here. */
export async function saveWorkspace(context: vscode.ExtensionContext, entry: NamedWorkspace): Promise<void> {
	const items = loadWorkspaces(context).filter((w) => w.name !== entry.name);
	items.unshift(entry);
	await context.workspaceState.update(WORKSPACES_KEY, { version: 1, items } satisfies NamedWorkspacesV1);
}

export async function deleteWorkspace(context: vscode.ExtensionContext, name: string): Promise<boolean> {
	const items = loadWorkspaces(context);
	const kept = items.filter((w) => w.name !== name);
	if (kept.length === items.length) {
		return false;
	}
	await context.workspaceState.update(WORKSPACES_KEY, { version: 1, items: kept } satisfies NamedWorkspacesV1);
	return true;
}
