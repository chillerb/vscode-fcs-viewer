import type { FcsWarning } from './errors';

export type FcsDataType = 'F' | 'D' | 'I' | 'A';
export type FcsMode = 'L' | 'C' | 'U';
export type Endianness = 'little' | 'big' | 'mixed';

/** FCS segment offsets. `end` is INCLUSIVE, per the spec. */
export interface FcsSegmentOffsets {
	begin: number;
	end: number;
}

export interface FcsHeader {
	version: string;
	text: FcsSegmentOffsets;
	data: FcsSegmentOffsets;
	analysis: FcsSegmentOffsets;
}

export type AmplificationKind = 'linear' | 'log';

/** How a channel is used, derived from its name. Drives default transforms. */
export type ChannelKind = 'time' | 'scatter' | 'marker' | 'other';

export interface FcsChannel {
	/** 0-based column index. */
	index: number;
	/** 1-based n from $PnN. */
	n: number;
	/** $PnN, e.g. "Nd143Di" or "R780-A". */
	name: string;
	/** $PnS marker label, e.g. "143Nd_CD49b" or "cd3". */
	label?: string;
	/** Label when present, else name. */
	displayName: string;
	/** $PnB bit width. */
	bits: number;
	/** $PnR. */
	range: number;
	amplification: AmplificationKind;
	/** $PnE f1. */
	logDecades: number;
	/** $PnE f2, after the f2===0 repair. */
	logOffset: number;
	/** $PnG. */
	gain?: number;
	/** $PnV. */
	voltage?: number;
	kind: ChannelKind;
}

export interface FcsSpillover {
	/** Which keyword it came from; vendors disagree. */
	source: '$SPILLOVER' | '$SPILL' | 'SPILL';
	/** Detector names, resolved against $PnN. */
	channels: string[];
	/** Column indices in the event matrix, parallel to `channels`. */
	channelIndices: number[];
	size: number;
	/** Row-major size*size. */
	matrix: Float64Array;
}

export interface FcsMetadata {
	version: string;
	header: FcsHeader;
	/** Uppercased keys to raw values, including supplemental TEXT. */
	keywords: Record<string, string>;
	delimiter: string;
	mode: FcsMode;
	dataType: FcsDataType;
	byteOrd: string;
	endianness: Endianness;
	/** $PAR */
	parameterCount: number;
	/** Effective count after cross-checking $TOT against the DATA segment length. */
	eventCount: number;
	/** $TOT as written. */
	declaredEventCount: number;
	channels: FcsChannel[];
	spillover?: FcsSpillover;
	nextData: number;
	timestep?: number;
	cytometer?: string;
	cytometerSerial?: string;
	software?: string;
	acquisitionDate?: string;
	beginTime?: string;
	endTime?: string;
	originalFile?: string;
	warnings: FcsWarning[];
	/** Total file size in bytes. */
	byteSize: number;
}

export interface FcsDataset {
	metadata: FcsMetadata;
	/**
	 * COLUMN-MAJOR: value(event e, channel c) === matrix[c * eventCount + e].
	 * Chosen so per-channel work (transforms, histograms, stats, sorting,
	 * compensation) is a contiguous scan rather than a 224-byte stride.
	 */
	matrix: Float32Array;
	eventCount: number;
	channelCount: number;
}

export interface CancellationLike {
	readonly isCancellationRequested: boolean;
}

export interface FcsParseOptions {
	/** Apply $PnE log decode and $PnG gain at parse time. Default true. */
	applyScaling?: boolean;
	/** Hard cap on total values; exceeding it throws FCS_TOO_LARGE. */
	maxValues?: number;
	signal?: CancellationLike;
}

/** Zero-copy view of one channel's values. Free because the matrix is column-major. */
export function channelColumn(ds: FcsDataset, channel: number): Float32Array {
	const n = ds.eventCount;
	return ds.matrix.subarray(channel * n, (channel + 1) * n);
}
