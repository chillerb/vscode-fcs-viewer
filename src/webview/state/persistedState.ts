import type { AppState, AxisConfig, CardConfig, TableState } from './appReducer';
import { clampWidth, INSPECTOR_LIMITS, SAMPLES_LIMITS } from './layout';

/**
 * The persisted UI blob and the rules for reading one.
 *
 * Split from persistence.ts, which owns the actual read and write, because
 * that module calls acquireVsCodeApi at import time -- so the validation and
 * migration could not be exercised without a webview. This half is pure.
 */

/**
 * Bumped whenever the persisted shape widens, not only when it breaks.
 *
 * The range check in `coerce` is what lets an older build refuse a blob it
 * cannot read. Adding the `umap` card kind without bumping would have left
 * this at 3, so an older build would accept a UMAP card and hand it to
 * migrateCard's default branch, which reads `card.y` -- a card kind it has
 * never heard of, crashing rather than declining.
 *
 * 5 added the sidebar widths.
 */
export const PERSISTED_VERSION = 5;

export interface PersistedState {
	version: number;
	/**
	 * Which viewer tab this is. VS Code hands this back as the `state` argument
	 * of deserializeWebviewPanel, and it is the only way a restored tab can
	 * reclaim its own sample list rather than another tab's.
	 */
	panelId?: string;
	activeTab?: AppState['activeTab'];
	sampleN?: number | null;
	compensate?: boolean;
	defaults?: { cofactor: number };
	cards?: CardConfig[];
	table?: TableState;
	manualMapping?: Record<string, number>;
	layout?: AppState['layout'];
}

/** An axis is only usable if it carries a channel reference. */
function isAxis(a: unknown): a is AxisConfig {
	const axis = a as AxisConfig | undefined;
	return typeof axis === 'object' && axis !== null
		&& typeof axis.channel === 'object' && axis.channel !== null
		&& typeof axis.channel.name === 'string' && typeof axis.channel.index === 'number';
}

/**
 * Is this blob actually a card of the kind it claims to be?
 *
 * The envelope was validated but the cards were not, so a truncated write or a
 * hand-edited blob reached the card components and threw there -- and the
 * webview's own setState restore is not inside a try/catch, so it blanked the
 * panel with nothing said. The host's stores already take the opposite
 * posture ("a corrupt entry is dropped rather than blocking the command");
 * this is the one store that did not.
 */
function isCard(card: unknown): card is CardConfig {
	const c = card as CardConfig | undefined;
	if (typeof c !== 'object' || c === null || typeof c.id !== 'string') {
		return false;
	}
	switch (c.kind) {
		case 'umap':
			return Array.isArray(c.channels);
		case 'histogram':
			return isAxis(c.x);
		case 'scatter':
		case 'contour':
			return isAxis(c.x) && isAxis(c.y);
		default:
			return false;
	}
}

/**
 * Bring a persisted card up to the current shape. Cards saved before the
 * transform was renamed carry 'arcsinh', and version 2 wrote flog parameters
 * of M = T = 1 on every axis.
 */
function migrateCard(card: CardConfig, version: number): CardConfig {
	const axis = (a: AxisConfig): AxisConfig => {
		const next: AxisConfig = {
			...a,
			transform: (a.transform as string) === 'arcsinh' ? 'arsinh' : a.transform,
		};
		// Version 2 stamped the GatingML defaults of M = T = 1 onto every axis,
		// where they were inert. Under the current framing they are not inert:
		// they would pin the axis to 0.1 - 1 and hide the data. Dropping them
		// puts those axes back on derived parameters.
		if (version < 3) {
			delete next.logM;
			delete next.logT;
		}
		return next;
	};
	switch (card.kind) {
		// UMAP has no axes to migrate.
		case 'umap':
			return card;
		case 'histogram':
			return { ...card, x: axis(card.x) };
		default:
			return { ...card, x: axis(card.x), y: axis(card.y) };
	}
}

/**
 * Validate and migrate a persisted blob into a state patch.
 *
 * Shared by the webview's own setState restore and by a named viewer workspace
 * pushed from the host, so both go through exactly the same migration.
 */
export function coerce(saved: PersistedState | undefined): Partial<AppState> | undefined {
	if (!saved || !Array.isArray(saved.cards) || typeof saved.version !== 'number'
		|| saved.version < 1 || saved.version > PERSISTED_VERSION) {
		return undefined;
	}
	return {
		...(saved.activeTab !== undefined ? { activeTab: saved.activeTab } : {}),
		// A persisted null would silently re-transfer every event on every
		// window reload, with no user action to blame it on.
		...(saved.sampleN !== undefined && saved.sampleN !== null ? { sampleN: saved.sampleN } : {}),
		...(saved.compensate !== undefined ? { compensate: saved.compensate } : {}),
		...(saved.defaults !== undefined ? { defaults: { cofactor: saved.defaults.cofactor } } : {}),
		// Unreadable cards are dropped, not fatal: losing one tile beats
		// losing the workspace.
		cards: saved.cards.filter(isCard).map((c) => migrateCard(c, saved.version)),
		// Clamped on the way in, not just on the way out of a drag: a width
		// from a maximised window would otherwise come back and swallow a
		// narrow one, and the same blob travels between machines inside a
		// saved workspace.
		...(saved.layout !== undefined
			? {
				layout: {
					samplesWidth: clampWidth(saved.layout.samplesWidth, SAMPLES_LIMITS),
					inspectorWidth: clampWidth(saved.layout.inspectorWidth, INSPECTOR_LIMITS),
				},
			}
			: {}),
		...(saved.table !== undefined
			? { table: { visibleColumns: saved.table.visibleColumns ?? [], sort: saved.table.sort ?? null } }
			: {}),
		manualMapping: saved.manualMapping ?? {},
	};
}
