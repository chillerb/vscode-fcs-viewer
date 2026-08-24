import * as vscode from 'vscode';
import { parseFcs, type FcsDataset } from '../common/fcs';
import { computeBasicStats, fillQuantiles, type ChannelStats } from '../common/fcs/stats';
import { buildPermutation } from '../common/sampling';
import { channelColumn } from '../common/fcs/types';
import { getLogger } from './logger';

export interface ParsedFile {
	uri: vscode.Uri;
	fileName: string;
	dataset: FcsDataset;
	stats: ChannelStats[];
	/** Set once the quantile pass has run. */
	hasQuantiles: boolean;
	/**
	 * Subsample order, built lazily. Lives on the file rather than the panel so
	 * it survives re-activation and two tabs on the same file draw the same
	 * cells. 585 KB against a 31 MB entry.
	 */
	permutation?: Uint32Array;
	seed: number;
}

/**
 * How many parsed matrices to keep. Three lets an A/B comparison stay instant
 * without a third panel pushing memory to hundreds of megabytes -- a CyTOF
 * matrix is ~31 MB.
 */
const CACHE_SIZE = 3;

/** Fixed, so the same file always yields the same cells across sessions. */
const DEFAULT_SEED = 0x5eed;

const QUANTILE_CHUNK = 4;

/**
 * Parsed matrices, shared by every viewer tab.
 *
 * Keyed by URI rather than by sample id, so two tabs showing the same file
 * parse it once and share the result. Holding this per-registry instead would
 * multiply memory by the number of open tabs for no benefit.
 *
 * One instance, created by activate() and passed down, rather than module
 * globals. Sharing across tabs is the requirement; being reachable from
 * anywhere is not, and the difference is why a pin leak was easy to introduce
 * and hard to see -- nothing owned the lifetime. It also removes the
 * clearMatrixCache() test hook that existed purely so tests could get a clean
 * slate.
 */
export class MatrixCache {
	private readonly cache = new Map<string, ParsedFile>();
	/** Concurrent requests for the same file share one parse rather than racing. */
	private readonly inFlight = new Map<string, Promise<ParsedFile>>();
	/**
	 * Active files, exempt from eviction. Every subsample change re-slices from
	 * this cache, so letting one tab evict another tab's active file would turn
	 * a dropdown change into a remote re-read and re-parse.
	 */
	private readonly pinned = new Set<string>();
	private readonly quantilesInProgress = new Set<string>();

	/**
	 * The eviction ceiling counts only pins on entries actually in the cache.
	 *
	 * A pin left on a URI that has since been dropped would otherwise raise the
	 * ceiling for an entry that is not there.
	 */
	private ceiling(): number {
		let residentPins = 0;
		for (const key of this.pinned) {
			if (this.cache.has(key)) {
				residentPins++;
			}
		}
		return Math.max(CACHE_SIZE, residentPins);
	}

	private touch(key: string, value: ParsedFile): void {
		this.cache.delete(key);
		this.cache.set(key, value);
		if (this.cache.size <= this.ceiling()) {
			return;
		}
		for (const oldest of [...this.cache.keys()]) {
			if (this.cache.size <= this.ceiling()) {
				break;
			}
			if (!this.pinned.has(oldest)) {
				this.cache.delete(oldest);
			}
		}
	}

	pin(uri: vscode.Uri): void {
		this.pinned.add(uri.toString());
	}

	unpin(uri: vscode.Uri): void {
		this.pinned.delete(uri.toString());
	}

	/**
	 * Whether this file is pinned. Residency is not a proxy for it -- a matrix
	 * can sit in the cache unpinned -- so a leaked pin is only visible from
	 * here, which is what the N2 regression test needs.
	 */
	isPinned(uri: vscode.Uri): boolean {
		return this.pinned.has(uri.toString());
	}

	/** The subsample order for a file, built on first use. */
	permutationOf(parsed: ParsedFile): Uint32Array {
		if (!parsed.permutation) {
			parsed.permutation = buildPermutation(parsed.dataset.eventCount, parsed.seed);
		}
		return parsed.permutation;
	}

	peek(uri: vscode.Uri): ParsedFile | undefined {
		return this.cache.get(uri.toString());
	}

	isResident(uri: vscode.Uri): boolean {
		return this.cache.has(uri.toString());
	}

	/** Read and parse a file, or return the cached parse. */
	async loadFile(uri: vscode.Uri, token?: vscode.CancellationToken): Promise<ParsedFile> {
		const key = uri.toString();
		const cached = this.cache.get(key);
		if (cached) {
			this.touch(key, cached);
			return cached;
		}
		const pending = this.inFlight.get(key);
		if (pending) {
			return pending;
		}

		const fileName = uri.path.split('/').pop() ?? key;
		const promise = (async (): Promise<ParsedFile> => {
			const log = getLogger();

			const readStart = Date.now();
			const bytes = await vscode.workspace.fs.readFile(uri);
			const readMs = Date.now() - readStart;

			const parseStart = Date.now();
			const dataset = parseFcs(bytes, token ? { signal: token } : {});
			const parseMs = Date.now() - parseStart;

			const statsStart = Date.now();
			const stats = dataset.metadata.channels.map((c) => computeBasicStats(channelColumn(dataset, c.index), c.index));
			const statsMs = Date.now() - statsStart;

			log.info(
				`Loaded ${fileName}: ${dataset.eventCount} x ${dataset.channelCount} ` +
				`(${(dataset.matrix.byteLength / 1048576).toFixed(1)} MB) ` +
				`read ${readMs}ms, parse ${parseMs}ms, stats ${statsMs}ms`,
			);
			for (const w of dataset.metadata.warnings) {
				log.warn(`${fileName}: [${w.code}] ${w.message}`);
			}

			const parsed: ParsedFile = { uri, fileName, dataset, stats, hasQuantiles: false, seed: DEFAULT_SEED };
			this.touch(key, parsed);
			return parsed;
		})();

		this.inFlight.set(key, promise);
		try {
			return await promise;
		} finally {
			this.inFlight.delete(key);
		}
	}

	/**
	 * Quantiles, computed lazily so the first paint is not blocked by them.
	 *
	 * Yields between chunks: this runs on the extension host, which serves every
	 * extension, and it must not block a subsample request that the user is
	 * waiting on. The scratch buffer is allocated once rather than per channel --
	 * the per-channel finite filter was allocating 585 KB and copying 146k floats
	 * 56 times over, which was most of the cost.
	 */
	async computeQuantileStats(parsed: ParsedFile): Promise<ChannelStats[]> {
		if (parsed.hasQuantiles) {
			return parsed.stats;
		}
		const key = parsed.uri.toString();
		if (this.quantilesInProgress.has(key)) {
			return parsed.stats;
		}
		this.quantilesInProgress.add(key);
		try {
			const started = Date.now();
			const scratch = new Float32Array(parsed.dataset.eventCount);
			const out = [...parsed.stats];
			for (let c = 0; c < out.length; c++) {
				out[c] = fillQuantiles(out[c]!, channelColumn(parsed.dataset, out[c]!.channel), scratch);
				if ((c + 1) % QUANTILE_CHUNK === 0) {
					await new Promise<void>((resolve) => setImmediate(resolve));
				}
			}
			parsed.stats = out;
			parsed.hasQuantiles = true;
			getLogger().info(`Quantiles for ${parsed.fileName}: ${Date.now() - started}ms`);
			return out;
		} finally {
			this.quantilesInProgress.delete(key);
		}
	}

	/** Drop everything. Used by the debugEvictCache and debugReset test hooks. */
	clear(): void {
		this.cache.clear();
		this.inFlight.clear();
		this.pinned.clear();
		this.quantilesInProgress.clear();
	}
}
