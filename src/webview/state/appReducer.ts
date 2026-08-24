import type { FcsWarning } from '../../common/fcs/errors';
import type { TransformKind } from '../../common/fcs/transform';
import type { ChannelStats } from '../../common/fcs/stats';
import type { SampleSlice } from '../../common/protocol';
import type { ChannelKind } from '../../common/fcs/types';
import type { SampleSummary } from '../../common/protocol';
import type { SampleData } from './SampleData';
import type { ChannelRef } from './channelResolver';
import { INSPECTOR_LIMITS, SAMPLES_LIMITS } from './layout';

export type ColormapName = 'viridis' | 'inferno' | 'turbo' | 'mono';

/** The slice-dependent half of SampleData, rebuilt on every new slice. */
export type SliceInit = Parameters<SampleData['withSlice']>[0];
export type TabId = 'plots' | 'table' | 'overview';

export interface AxisConfig {
	channel: ChannelRef;
	transform: TransformKind;
	/** Only used by arsinh. */
	cofactor: number;
	/**
	 * GatingML flog parameters: flog(x, M, T) = (1/M)*log10(x/T) + 1, which
	 * maps [T*10^-M, T] onto [0, 1] and so defines the visible range of a log
	 * axis. Undefined means "derive from this channel's data", which is the
	 * default -- the spec's own M = T = 1 would frame every axis on 0.1 to 1.
	 */
	logM?: number;
	logT?: number;
	/** In raw data units; 'auto' derives from the data. */
	domain: 'auto' | [number, number];
}

export interface CardSpan {
	cols: 1 | 2 | 3;
	rows: 1 | 2;
}

export interface CardBase {
	id: string;
	title?: string;
	span: CardSpan;
}

export interface ScatterCardConfig extends CardBase {
	kind: 'scatter';
	x: AxisConfig;
	y: AxisConfig;
	density: boolean;
	colormap: ColormapName;
	pointSize: 1 | 2 | 3;
}

/**
 * A binned density contour: the same two channels as a scatter, drawn as
 * levels instead of points. Reads better than a dot plot once the populations
 * overlap, and unlike a scatter its appearance does not depend on how many
 * events happen to be in the subsample.
 */
export interface ContourCardConfig extends CardBase {
	kind: 'contour';
	x: AxisConfig;
	y: AxisConfig;
	colormap: ColormapName;
	/** Contour levels; Plotly treats this as a target, not a guarantee. */
	levels: number;
	coloring: 'fill' | 'heatmap' | 'lines';
	/** Overlay the events themselves, which is the conventional density plot. */
	showPoints: boolean;
}

/**
 * A UMAP projection of several channels onto two dimensions.
 *
 * `cells` is both the number of events embedded and the number plotted: UMAP
 * fits a model and can project further points through it, but that projection
 * costs about half a second of nearest-neighbour search that cannot be broken
 * up, which is worse than plotting fewer cells. Because slice rows arrive in
 * permutation order, the embedded cells are a prefix -- the same events every
 * other card draws first.
 */
export interface UmapCardConfig extends CardBase {
	kind: 'umap';
	/**
	 * Channels projected, captured when the card is made. Stored explicitly
	 * rather than resolved live so that switching to a sample from another
	 * panel reports the missing ones, exactly as a scatter card reports a
	 * missing axis, instead of silently embedding a different feature set.
	 */
	channels: ChannelRef[];
	/**
	 * UMAP's locality parameter, and the closest thing it has to t-SNE's
	 * perplexity: how many neighbours define the local structure.
	 */
	nNeighbors: number;
	/** How tightly points are allowed to pack together. */
	minDist: number;
	/**
	 * A ceiling, not a second subsample: the card takes `rows(cells)`, which
	 * clamps to the global subsample, so lowering the global size lowers this
	 * with it and the UMAP always shows cells the other cards are showing too.
	 * Clamped again to UMAP_MAX_CELLS.
	 */
	cells: number;
	/** Channel whose value colours each point; undefined colours by density. */
	colorBy: ChannelRef | undefined;
	colormap: ColormapName;
	pointSize: 1 | 2 | 3;
}

export interface HistogramCardConfig extends CardBase {
	kind: 'histogram';
	x: AxisConfig;
	binCount: number | 'auto';
	style: 'bars' | 'outline' | 'filled';
	yScale: 'count' | 'percent' | 'density';
}

export type CardConfig = ScatterCardConfig | ContourCardConfig | UmapCardConfig | HistogramCardConfig;

export interface AppState {
	status: 'booting' | 'loading' | 'ready' | 'error';
	/** Identifies this viewer tab, so it reclaims its own persisted samples. */
	panelId: string | undefined;
	/** Set once this workspace has been saved under a name. */
	workspaceName: string | undefined;
	error?: { message: string };
	samples: SampleSummary[];
	activeId: string | undefined;
	data: SampleData | undefined;
	warnings: FcsWarning[];
	activeTab: TabId;
	/** Sidebar widths in px, dragged by the user and persisted. */
	layout: { samplesWidth: number; inspectorWidth: number };

	/** Global, applying to every card and view. What the user asked for. */
	sampleN: number | null;
	/** Size requested from the host and not yet delivered; undefined when idle. */
	pendingSampleN: number | null | undefined;
	/** Monotonic; a reply carrying an older id has been superseded. */
	sliceRequestId: number;
	/** Highest activation id seen; an older 'fcs/sample' payload is stale. */
	activationId: number;
	/** Above this many bytes a transfer needs explicit confirmation. */
	maxSliceBytes: number;
	compensate: boolean;
	/**
	 * Seeds new cards. The transform is chosen per channel rather than
	 * globally, so only the cofactor lives here.
	 */
	defaults: { cofactor: number };

	cards: CardConfig[];
	selectedCardId: string | undefined;
	enlargedCardId: string | undefined;

	table: TableState;
	/** Result of resolving card channels against the active sample. */
	mapping: { unresolved: string[]; approximate: string[] } | undefined;
	/** Manual channel remappings, keyed by the card's channel name. */
	manualMapping: Record<string, number>;
}

export interface TableState {
	visibleColumns: number[];
	sort: { column: number; dir: 'asc' | 'desc' } | null;
}

export type Action =
	| { type: 'samples'; panelId: string; samples: SampleSummary[]; activeId?: string; workspaceName?: string }
	| { type: 'loading' }
	| { type: 'sampleLoaded'; data: SampleData; activationId: number; defaults: { sampleSize: number; cofactor: number }; maxSliceBytes: number }
	| { type: 'statsUpdated'; sampleId: string; stats: ChannelStats[] }
	| { type: 'sliceRequested'; requestId: number; n: number | null }
	| { type: 'sliceReceived'; slice: SampleSlice; init: SliceInit }
	| { type: 'sliceFailed'; requestId: number; message: string }
	| { type: 'warnings'; warnings: FcsWarning[] }
	| { type: 'error'; message: string }
	| { type: 'setTab'; tab: TabId }
	| { type: 'setSampleN'; n: number | null }
	| { type: 'setCompensate'; on: boolean }
	| { type: 'setDefaults'; patch: Partial<AppState['defaults']> }
	| { type: 'setLayout'; patch: Partial<AppState['layout']> }
	| { type: 'addCard'; kind: CardConfig['kind'] }
	| { type: 'duplicateCard'; id: string }
	| { type: 'removeCard'; id: string }
	| { type: 'moveCard'; id: string; toIndex: number }
	// Split by kind. A single action taking the intersection of three partials
	// accepted any field from any card, so `patch: { pointSize: 3 }` type-checked
	// against a histogram and the reducer's cast let it through.
	| { type: 'updateCard'; id: string; patch: Partial<Pick<CardBase, 'title' | 'span'>> }
	| { type: 'updateScatter'; id: string; patch: Partial<Omit<ScatterCardConfig, 'kind' | 'id'>> }
	| { type: 'updateContour'; id: string; patch: Partial<Omit<ContourCardConfig, 'kind' | 'id'>> }
	| { type: 'updateHistogram'; id: string; patch: Partial<Omit<HistogramCardConfig, 'kind' | 'id'>> }
	| { type: 'updateUmap'; id: string; patch: Partial<Omit<UmapCardConfig, 'kind' | 'id'>> }
	| { type: 'changeCardKind'; id: string; kind: CardConfig['kind'] }
	| { type: 'updateAxis'; id: string; axis: 'x' | 'y'; patch: Partial<AxisConfig> }
	| { type: 'selectCard'; id: string | undefined }
	| { type: 'enlargeCard'; id: string | undefined }
	| { type: 'setMapping'; mapping: AppState['mapping'] }
	| { type: 'remapChannel'; from: string; to: number }
	| { type: 'table'; patch: Partial<TableState> }
	| { type: 'restore'; state: Partial<AppState> };

export function initialState(): AppState {
	return {
		status: 'booting',
		panelId: undefined,
		workspaceName: undefined,
		samples: [],
		activeId: undefined,
		data: undefined,
		warnings: [],
		activeTab: 'plots',
		layout: { samplesWidth: SAMPLES_LIMITS.default, inspectorWidth: INSPECTOR_LIMITS.default },
		sampleN: 5000,
		pendingSampleN: undefined,
		sliceRequestId: 0,
		activationId: 0,
		maxSliceBytes: 16 * 1024 * 1024,
		compensate: false,
		defaults: { cofactor: 5 },
		cards: [],
		selectedCardId: undefined,
		enlargedCardId: undefined,
		table: { visibleColumns: [], sort: null },
		mapping: undefined,
		manualMapping: {},
	};
}

function nextCardId(): string {
	return `card-${crypto.randomUUID()}`;
}

/**
 * Forward and side scatter are already on a linear scale, and arsinh on a time
 * axis is nonsense; everything else is fluorescence or metal intensity, which
 * wants arsinh.
 */
function defaultTransformFor(kind: ChannelKind): TransformKind {
	return kind === 'time' || kind === 'scatter' ? 'linear' : 'arsinh';
}

function axisFor(state: AppState, channel: ChannelRef, kind: ChannelKind): AxisConfig {
	return {
		channel,
		transform: defaultTransformFor(kind),
		cofactor: state.defaults.cofactor,
		domain: 'auto',
	};
}

/**
 * Starting channels for a new card. Markers come first, and the pair advances
 * with each card so adding several does not produce identical plots.
 */
function pickChannels(state: AppState, nth: number): { x: ChannelRef; y: ChannelRef } | undefined {
	const channels = state.data?.metadata.channels;
	if (!channels || channels.length === 0) {
		return undefined;
	}
	const ranked = [...channels].sort((a, b) => rank(a.kind) - rank(b.kind));
	const ref = (c: (typeof ranked)[number]): ChannelRef => ({
		name: c.name,
		index: c.index,
		...(c.label !== undefined ? { label: c.label } : {}),
	});
	const first = ranked[(nth * 2) % ranked.length]!;
	const second = ranked[(nth * 2 + 1) % ranked.length] ?? first;
	return { x: ref(first), y: ref(second) };
}

function rank(kind: string): number {
	return kind === 'marker' ? 0 : kind === 'other' ? 1 : kind === 'scatter' ? 2 : 3;
}

function toRef(c: { name: string; index: number; label?: string }): ChannelRef {
	return { name: c.name, index: c.index, ...(c.label !== undefined ? { label: c.label } : {}) };
}

/**
 * Default projection channels: the markers.
 *
 * Time and the scatter channels are deliberately excluded -- Time is an
 * acquisition artefact and FSC/SSC would dominate a structure that is supposed
 * to be about marker expression. Files with no $PnS labels have no markers to
 * find, so those fall back to everything that is not Time.
 */
function defaultUmapChannels(state: AppState): ChannelRef[] {
	const channels = state.data?.metadata.channels ?? [];
	const markers = channels.filter((c) => c.kind === 'marker');
	return (markers.length > 0 ? markers : channels.filter((c) => c.kind !== 'time')).map(toRef);
}

/**
 * Hard ceiling on embedded cells, whatever the global subsample is.
 *
 * The neighbour graph is the expensive part and it is not linear: 10,000 cells
 * is already a noticeable wait for a plot whose structure is legible at a
 * fraction of that.
 */
export const UMAP_MAX_CELLS = 5000;

const UMAP_DEFAULTS = { nNeighbors: 15, minDist: 0.1, cells: 1000 } as const;

function makeCard(state: AppState, kind: CardConfig['kind']): CardConfig | undefined {
	const picked = pickChannels(state, state.cards.length);
	if (!picked) {
		return undefined;
	}
	const channels = state.data!.metadata.channels;
	const kindOf = (ref: ChannelRef): ChannelKind => channels[ref.index]?.kind ?? 'other';

	const base = { id: nextCardId(), span: { cols: 1, rows: 1 } as CardSpan };
	const x = axisFor(state, picked.x, kindOf(picked.x));
	const y = axisFor(state, picked.y, kindOf(picked.y));
	if (kind === 'histogram') {
		return { ...base, kind: 'histogram', x, binCount: 'auto', style: 'outline', yScale: 'count' };
	}
	if (kind === 'contour') {
		return { ...base, kind: 'contour', x, y, colormap: 'viridis', levels: 12, coloring: 'fill', showPoints: false };
	}
	if (kind === 'umap') {
		return {
			...base,
			kind: 'umap',
			span: { cols: 2, rows: 2 },
			channels: defaultUmapChannels(state),
			...UMAP_DEFAULTS,
			colorBy: undefined,
			colormap: 'viridis',
			pointSize: 2,
		};
	}
	return { ...base, kind: 'scatter', x, y, density: true, colormap: 'viridis', pointSize: 2 };
}

function mapCard(state: AppState, id: string, fn: (c: CardConfig) => CardConfig): AppState {
	// Only the mutated card object is replaced, so every other card keeps its
	// referential identity and React.memo skips re-rendering it.
	return { ...state, cards: state.cards.map((c) => (c.id === id ? fn(c) : c)) };
}

export function reducer(state: AppState, action: Action): AppState {
	switch (action.type) {
		case 'samples':
			return {
				...state,
				panelId: action.panelId,
				samples: action.samples,
				activeId: action.activeId ?? state.activeId,
				workspaceName: action.workspaceName,
			};

		case 'loading':
			return { ...state, status: state.data ? state.status : 'loading' };

		case 'sampleLoaded': {
			// Two sample selections can be in flight at once, and a postMessage
			// cannot be unsent, so an activation older than the newest seen is
			// dropped rather than displayed. Same guard as 'sliceReceived'.
			if (action.activationId < state.activationId) {
				return state;
			}
			// A new sample invalidates any slice request against the old one.
			const defaultColumns = action.data.metadata.channels
				.filter((c) => c.kind !== 'time')
				.slice(0, 12)
				.map((c) => c.index);
			const next: AppState = {
				...state,
				status: 'ready',
				data: action.data,
				activationId: action.activationId,
				activeId: action.data.id,
				warnings: action.data.metadata.warnings,
				pendingSampleN: undefined,
				maxSliceBytes: action.maxSliceBytes,
				sampleN: state.status === 'booting' ? action.defaults.sampleSize : state.sampleN,
				defaults: state.status === 'booting'
					? { ...state.defaults, cofactor: action.defaults.cofactor }
					: state.defaults,
				// Deliberately NOT reset for a sample without a spillover
				// matrix. Compensation is a global intent: switching to an
				// uncompensatable sample and back used to leave it silently
				// off, which is a wrong plot that looks like a right one.
				// SampleData.column falls through to raw values, and the
				// status bar says so.
				compensate: state.compensate,
				table: {
					...state.table,
					visibleColumns: state.table.visibleColumns.length > 0 && state.cards.length > 0
						? state.table.visibleColumns.filter((i) => i < action.data.channelCount)
						: defaultColumns,
					sort: null,
				},
			};
			if (next.cards.length === 0) {
				const card = makeCard(next, 'scatter');
				if (card) {
					next.cards = [card];
					next.selectedCardId = card.id;
				}
			}
			return next;
		}

		case 'statsUpdated':
			// Applied to CURRENT state, never to a SampleData captured in a
			// message handler: that capture may be a slice already replaced.
			return state.data?.id === action.sampleId
				? { ...state, data: state.data.withStats(action.stats) }
				: state;

		case 'sliceRequested':
			return { ...state, sliceRequestId: action.requestId, pendingSampleN: action.n };

		case 'sliceReceived': {
			const stale =
				action.slice.requestId !== state.sliceRequestId ||
				state.data === undefined ||
				state.data.id !== action.slice.sampleId;
			if (stale || !state.data) {
				return state;
			}
			return { ...state, data: state.data.withSlice(action.init), pendingSampleN: undefined };
		}

		case 'sliceFailed':
			return action.requestId === state.sliceRequestId
				? { ...state, pendingSampleN: undefined }
				: state;

		case 'warnings':
			return { ...state, warnings: action.warnings };

		case 'error':
			return { ...state, status: state.data ? state.status : 'error', error: { message: action.message } };

		case 'setTab':
			return { ...state, activeTab: action.tab };

		case 'setSampleN':
			return { ...state, sampleN: action.n };

		case 'setCompensate':
			return { ...state, compensate: action.on };

		case 'setDefaults':
			return { ...state, defaults: { ...state.defaults, ...action.patch } };

		case 'setLayout':
			return { ...state, layout: { ...state.layout, ...action.patch } };

		case 'addCard': {
			const card = makeCard(state, action.kind);
			return card ? { ...state, cards: [...state.cards, card], selectedCardId: card.id } : state;
		}

		case 'duplicateCard': {
			const source = state.cards.find((c) => c.id === action.id);
			if (!source) {
				return state;
			}
			const copy = { ...source, id: nextCardId() } as CardConfig;
			const at = state.cards.indexOf(source) + 1;
			const cards = [...state.cards];
			cards.splice(at, 0, copy);
			return { ...state, cards, selectedCardId: copy.id };
		}

		case 'removeCard': {
			const cards = state.cards.filter((c) => c.id !== action.id);
			return {
				...state,
				cards,
				selectedCardId: state.selectedCardId === action.id ? cards[0]?.id : state.selectedCardId,
				enlargedCardId: state.enlargedCardId === action.id ? undefined : state.enlargedCardId,
			};
		}

		case 'moveCard': {
			const from = state.cards.findIndex((c) => c.id === action.id);
			if (from < 0 || action.toIndex < 0 || action.toIndex > state.cards.length) {
				return state;
			}
			const cards = [...state.cards];
			const [moved] = cards.splice(from, 1);
			cards.splice(from < action.toIndex ? action.toIndex - 1 : action.toIndex, 0, moved!);
			return { ...state, cards };
		}

		case 'updateCard':
			return mapCard(state, action.id, (c) => ({ ...c, ...action.patch }));

		case 'updateScatter':
			return mapCard(state, action.id, (c) => (c.kind === 'scatter' ? { ...c, ...action.patch } : c));

		case 'updateContour':
			return mapCard(state, action.id, (c) => (c.kind === 'contour' ? { ...c, ...action.patch } : c));

		case 'updateHistogram':
			return mapCard(state, action.id, (c) => (c.kind === 'histogram' ? { ...c, ...action.patch } : c));

		case 'updateUmap':
			return mapCard(state, action.id, (c) => (c.kind === 'umap' ? { ...c, ...action.patch } : c));

		case 'changeCardKind':
			return mapCard(state, action.id, (c) => {
				if (c.kind === action.kind) {
					return c;
				}
				// Keep id, span and title; only the type-specific options are
				// replaced. UMAP has no axes at all, so the axes are recovered
				// from the card when it has them and rebuilt from the sample
				// when it does not.
				const base = { id: c.id, span: c.span, ...(c.title !== undefined ? { title: c.title } : {}) };
				const fallback = makeCard(state, 'scatter');
				const fallbackX = fallback && 'x' in fallback ? fallback.x : undefined;
				const x = c.kind === 'umap' ? fallbackX : c.x;
				const y = c.kind === 'umap'
					? (fallback && 'y' in fallback ? fallback.y : undefined)
					: (c.kind === 'histogram' ? c.x : c.y);
				if (action.kind !== 'umap' && (!x || !y)) {
					return c;
				}
				switch (action.kind) {
					case 'histogram':
						return { ...base, kind: 'histogram', x: x!, binCount: 'auto', style: 'outline', yScale: 'count' };
					case 'contour':
						return { ...base, kind: 'contour', x: x!, y: y!, colormap: 'viridis', levels: 12, coloring: 'fill', showPoints: false };
					case 'scatter':
						return { ...base, kind: 'scatter', x: x!, y: y!, density: true, colormap: 'viridis', pointSize: 2 };
					case 'umap':
						return {
							...base,
							kind: 'umap',
							channels: defaultUmapChannels(state),
							...UMAP_DEFAULTS,
							colorBy: undefined,
							colormap: 'viridis',
							pointSize: 2,
						};
				}
			});

		case 'updateAxis':
			return mapCard(state, action.id, (c) => {
				// UMAP has no axes: its coordinates are arbitrary, so there is
				// nothing to transform or range.
				if (c.kind === 'umap') {
					return c;
				}
				if (action.axis === 'y') {
					return c.kind === 'histogram' ? c : { ...c, y: { ...c.y, ...action.patch } };
				}
				return { ...c, x: { ...c.x, ...action.patch } };
			});

		case 'selectCard':
			return { ...state, selectedCardId: action.id };

		case 'enlargeCard':
			return { ...state, enlargedCardId: action.id, selectedCardId: action.id ?? state.selectedCardId };

		case 'setMapping':
			return { ...state, mapping: action.mapping };

		case 'remapChannel':
			return { ...state, manualMapping: { ...state.manualMapping, [action.from]: action.to } };

		case 'table':
			return { ...state, table: { ...state.table, ...action.patch } };

		case 'restore':
			return { ...state, ...action.state };
	}
}
