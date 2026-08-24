import type { FcsChannel, FcsMetadata } from '../../common/fcs/types';

/**
 * How a plot card refers to a channel. All three identifiers are stored, and
 * all three must match for the reference to resolve.
 */
export interface ChannelRef {
	name: string;
	label?: string;
	index: number;
}

export type ResolutionMethod = 'exact' | 'manual';

export interface Resolution {
	channel: FcsChannel | undefined;
	method: ResolutionMethod | undefined;
	/** True when the match came from a manual remap rather than the file itself. */
	approximate: boolean;
}

export function channelRef(c: FcsChannel): ChannelRef {
	return { name: c.name, index: c.index, ...(c.label !== undefined ? { label: c.label } : {}) };
}

export interface ResolverIndex {
	channels: FcsChannel[];
}

export function buildIndex(meta: FcsMetadata): ResolverIndex {
	return { channels: meta.channels };
}

/**
 * Resolve a card's channel reference against the active sample.
 *
 * Matching is exact and requires ALL of index, $PnN and $PnS to agree. There is
 * no case folding, no punctuation stripping, and no falling back from one
 * identifier to another: a near-match is far more likely to be a different
 * marker than the same one, and plotting the wrong marker silently is the worst
 * outcome available. When nothing matches the card greys out and names the
 * channel, which the user can then re-pick.
 */
export function resolveChannel(
	ref: ChannelRef,
	index: ResolverIndex,
	manual?: Map<string, number>,
): Resolution {
	const override = manual?.get(ref.name);
	if (override !== undefined && index.channels[override]) {
		return { channel: index.channels[override], method: 'manual', approximate: true };
	}

	const candidate = index.channels[ref.index];
	if (candidate && candidate.name === ref.name && candidate.label === ref.label) {
		return { channel: candidate, method: 'exact', approximate: false };
	}

	return { channel: undefined, method: undefined, approximate: false };
}

export interface MappingReport {
	total: number;
	resolved: number;
	unresolved: string[];
	/** Resolved only because of a manual remap. */
	approximate: string[];
}

export function summariseMapping(refs: ChannelRef[], index: ResolverIndex, manual?: Map<string, number>): MappingReport {
	const seen = new Map<string, Resolution>();
	for (const ref of refs) {
		if (!seen.has(ref.name)) {
			seen.set(ref.name, resolveChannel(ref, index, manual));
		}
	}
	const unresolved: string[] = [];
	const approximate: string[] = [];
	for (const [name, r] of seen) {
		if (!r.channel) {
			unresolved.push(name);
		} else if (r.approximate) {
			approximate.push(name);
		}
	}
	return { total: seen.size, resolved: seen.size - unresolved.length, unresolved, approximate };
}

export interface ProjectionRow {
	ref: ChannelRef;
	/** In the card's projection. */
	on: boolean;
	/** Present in the sample being shown. */
	present: boolean;
}

/**
 * The channels a UMAP card's projection list should offer.
 *
 * The card's own channels always come first, whether or not the active sample
 * has them. Listing only the sample's channels would hide a selected channel
 * the sample lacks, which is worse than it sounds: the card refuses to compute
 * until that channel is removed, and an invisible checkbox cannot be unticked.
 * The sample's remaining channels follow, so the config stays stable while the
 * user moves between samples.
 */
export function projectionRows(
	selected: ChannelRef[],
	available: FcsChannel[],
	index: ResolverIndex,
	manual?: Map<string, number>,
): ProjectionRow[] {
	const chosen = new Set(selected.map((r) => r.name));
	return [
		...selected.map((ref) => ({
			ref,
			on: true,
			present: resolveChannel(ref, index, manual).channel !== undefined,
		})),
		...available
			.filter((c) => !chosen.has(c.name))
			.map((c) => ({ ref: channelRef(c), on: false, present: true })),
	];
}

export interface ColorChoice {
	/** $PnN, or '' for density. */
	value: string;
	label: string;
	ref: ChannelRef | undefined;
}

export interface ColorChoices {
	/**
	 * What the card is currently coloured by, listed separately so the UI can
	 * put it above a divider. Always present -- density included, so the
	 * divider does not appear and disappear as the selection changes.
	 */
	current: ColorChoice;
	/** Density, then every channel this sample has. */
	available: ColorChoice[];
}

/**
 * The colour-by choices for a UMAP card.
 *
 * Keyed by $PnN rather than by index, for the reason index-keying is a trap
 * here: two panels put different markers at the same index, so an index-keyed
 * select shows whichever marker happens to sit there in the sample being
 * looked at -- and picking anything then rewrites the card's channel. A
 * configured channel the sample lacks stays selectable, flagged, exactly as
 * projectionRows keeps unavailable projection channels.
 */
export function colorChoices(colorBy: ChannelRef | undefined, available: FcsChannel[]): ColorChoices {
	const here = colorBy !== undefined && available.some((c) => c.name === colorBy.name);
	return {
		current: colorBy === undefined
			? { value: '', label: 'Density', ref: undefined }
			: {
				value: colorBy.name,
				label: here ? colorBy.label ?? colorBy.name : `${colorBy.label ?? colorBy.name} (not in this sample)`,
				ref: colorBy,
			},
		available: [
			{ value: '', label: 'Density', ref: undefined },
			...available.map((c) => ({ value: c.name, label: c.label ?? c.name, ref: channelRef(c) })),
		],
	};
}
