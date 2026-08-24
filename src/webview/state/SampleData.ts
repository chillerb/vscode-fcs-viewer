import { compensateColumns } from '../../common/fcs';
import type { FcsMetadata, FcsSpillover } from '../../common/fcs/types';
import type { ChannelStats } from '../../common/fcs/stats';

export interface SampleDataInit {
	id: string;
	fileName: string;
	metadata: FcsMetadata;
	/** Column-major over the SAMPLED rows: matrix[c * sampledCount + i]. */
	matrix: Float32Array;
	/** Original event index of row i. */
	eventIds: Uint32Array;
	/** Rows present. */
	sampledCount: number;
	/** Events in the FILE. */
	eventCount: number;
	channelCount: number;
	stats: ChannelStats[];
	seed: number;
	spillover?: FcsSpillover;
	spilloverInverse?: Float64Array;
	clamped?: boolean;
}

/**
 * The active sample's subsampled events and every cache derived from them.
 *
 * Deliberately a plain class outside React: putting a multi-megabyte
 * Float32Array in useState invites accidental spreads, devtools serialisation
 * hangs, and pointless memo comparisons. Components read from it imperatively.
 *
 * Only the subsample is here. `eventCount` is the FILE total, used for display;
 * `sampledCount` is the row stride of `matrix` and the only number that may be
 * used to index it.
 */
export class SampleData {
	readonly id: string;
	readonly fileName: string;
	readonly metadata: FcsMetadata;
	readonly matrix: Float32Array;
	readonly eventIds: Uint32Array;
	readonly sampledCount: number;
	readonly eventCount: number;
	readonly channelCount: number;
	readonly stats: ChannelStats[];
	readonly seed: number;
	readonly spillover: FcsSpillover | undefined;
	readonly spilloverInverse: Float64Array | undefined;
	/** The host served fewer rows than asked for, to stay inside the budget. */
	readonly clamped: boolean;

	/**
	 * subarray() returns a NEW view every call, so without this every render saw
	 * a fresh identity for the same column and recomputed the whole axis plan.
	 */
	private readonly rawColumns = new Map<number, Float32Array>();
	private readonly rowCache = new Map<number, Uint32Array>();
	private compensated: Map<number, Float32Array> | undefined;
	private ascending: Uint32Array | undefined;

	constructor(init: SampleDataInit) {
		this.id = init.id;
		this.fileName = init.fileName;
		this.metadata = init.metadata;
		this.matrix = init.matrix;
		this.eventIds = init.eventIds;
		this.sampledCount = init.sampledCount;
		this.eventCount = init.eventCount;
		this.channelCount = init.channelCount;
		this.stats = init.stats;
		this.seed = init.seed;
		this.spillover = init.spillover;
		this.spilloverInverse = init.spilloverInverse;
		this.clamped = init.clamped ?? false;
	}

	private get init(): SampleDataInit {
		return {
			id: this.id,
			fileName: this.fileName,
			metadata: this.metadata,
			matrix: this.matrix,
			eventIds: this.eventIds,
			sampledCount: this.sampledCount,
			eventCount: this.eventCount,
			channelCount: this.channelCount,
			stats: this.stats,
			seed: this.seed,
			clamped: this.clamped,
			...(this.spillover ? { spillover: this.spillover } : {}),
			...(this.spilloverInverse ? { spilloverInverse: this.spilloverInverse } : {}),
		};
	}

	/** Same events, richer statistics. Derived caches stay valid. */
	withStats(stats: ChannelStats[]): SampleData {
		const next = new SampleData({ ...this.init, stats });
		for (const [k, v] of this.rawColumns) {
			next.rawColumns.set(k, v);
		}
		for (const [k, v] of this.rowCache) {
			next.rowCache.set(k, v);
		}
		next.compensated = this.compensated;
		next.ascending = this.ascending;
		return next;
	}

	/**
	 * A different set of events. Every derived cache is invalidated: carrying
	 * any of them over would silently serve the previous slice's values.
	 */
	withSlice(slice: Omit<SampleDataInit, 'id' | 'fileName' | 'metadata' | 'stats' | 'spillover' | 'spilloverInverse'>): SampleData {
		return new SampleData({ ...this.init, ...slice });
	}

	get canCompensate(): boolean {
		return this.spillover !== undefined && this.spilloverInverse !== undefined;
	}

	/** Zero-copy view of one raw channel, memoised for referential stability. */
	rawColumn(channel: number): Float32Array {
		let col = this.rawColumns.get(channel);
		if (!col) {
			col = this.matrix.subarray(channel * this.sampledCount, (channel + 1) * this.sampledCount);
			this.rawColumns.set(channel, col);
		}
		return col;
	}

	/**
	 * A channel's values, compensated when asked and when the channel is covered
	 * by the spillover matrix. Channels outside it (FSC, SSC, Time) fall through
	 * to the raw column, which is correct rather than an optimisation.
	 *
	 * Compensation has no cross-event term, so restricting it to a subset of
	 * events gives bit-identical values for those events.
	 */
	column(channel: number, compensate: boolean): Float32Array {
		if (!compensate || !this.canCompensate) {
			return this.rawColumn(channel);
		}
		if (!this.compensated) {
			const sp = this.spillover!;
			const cols = compensateColumns(this.matrix, this.sampledCount, sp, this.spilloverInverse!);
			this.compensated = new Map();
			sp.channelIndices.forEach((idx, i) => this.compensated!.set(idx, cols[i]!));
		}
		return this.compensated.get(channel) ?? this.rawColumn(channel);
	}

	/** True when this channel's values change under compensation. */
	isCompensated(channel: number): boolean {
		return this.spillover?.channelIndices.includes(channel) ?? false;
	}

	/**
	 * Row indices to render.
	 *
	 * Rows arrive in permutation order, so a prefix of length n IS the n-event
	 * subsample -- every card draws the same cells, and a smaller n is nested
	 * inside a larger one. That is what lets the no-WebGL cap and any shrink of
	 * the subsample be served locally with no round-trip.
	 */
	rows(n: number | null): Uint32Array {
		const size = n === null ? this.sampledCount : Math.min(n, this.sampledCount);
		const cached = this.rowCache.get(size);
		if (cached) {
			return cached;
		}
		const out = new Uint32Array(size);
		for (let i = 0; i < size; i++) {
			out[i] = i;
		}
		if (this.rowCache.size > 4) {
			const oldest = this.rowCache.keys().next().value;
			if (oldest !== undefined) {
				this.rowCache.delete(oldest);
			}
		}
		this.rowCache.set(size, out);
		return out;
	}

	/**
	 * Rows ordered by original event index. Rows are stored shuffled, so the
	 * table would otherwise show a jumping event column.
	 */
	ascendingRows(): Uint32Array {
		if (!this.ascending) {
			const order = new Uint32Array(this.sampledCount);
			for (let i = 0; i < this.sampledCount; i++) {
				order[i] = i;
			}
			const ids = this.eventIds;
			order.sort((a, b) => ids[a]! - ids[b]!);
			this.ascending = order;
		}
		return this.ascending;
	}

	/** Sizes currently held in the row cache; used by tests. */
	get cachedRowSizes(): number[] {
		return [...this.rowCache.keys()];
	}
}
