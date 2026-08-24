import * as vscode from 'vscode';
import type { ChannelStats } from '../common/fcs/stats';
import type { SampleSummary } from '../common/protocol';
import { getLogger } from './logger';
import type { MatrixCache, ParsedFile } from './matrixCache';
import type { PersistedSample } from './workspaceStore';
import { gatherSlice } from '../common/sampling';
import type { SampleSlice } from '../common/protocol';

export interface LoadedSample {
	id: string;
	uri: vscode.Uri;
	fileName: string;
	dataset: ParsedFile['dataset'];
	stats: ChannelStats[];
}

interface Entry {
	uri: vscode.Uri;
	fileName: string;
	summary: SampleSummary;
}

/**
 * One viewer tab's samples: their ids, their order, and a cheap summary of each
 * (a few KB) so the sidebar renders instantly. The expensive part -- the parsed
 * event matrix -- lives in the process-wide matrixCache, so several tabs
 * showing the same file share a single parse.
 */
export class SampleRegistry {
	private readonly order: string[] = [];
	private readonly entries = new Map<string, Entry>();
	/** uri.toString() -> sample id. Kept in step with `entries`. */
	private readonly byUri = new Map<string, string>();
	private nextId = 1;

	/** The parsed matrices this tab shares with every other tab. */
	constructor(private readonly cache: MatrixCache) {}

	get summaries(): SampleSummary[] {
		return this.order.map((id) => this.entries.get(id)!.summary);
	}

	get ids(): string[] {
		return [...this.order];
	}

	has(uri: vscode.Uri): string | undefined {
		return this.byUri.get(uri.toString());
	}

	/** Registers a file and parses it once so the sidebar can show real counts. */
	async add(uri: vscode.Uri, token?: vscode.CancellationToken): Promise<string> {
		const existing = this.has(uri);
		if (existing !== undefined) {
			return existing;
		}
		const id = this.mintId();
		const fileName = uri.path.split('/').pop() ?? uri.toString();
		this.order.push(id);
		this.entries.set(id, {
			uri,
			fileName,
			summary: { id, fileName, uri: uri.toString(), eventCount: 0, channelCount: 0 },
		});
		this.byUri.set(uri.toString(), id);
		try {
			const loaded = await this.load(id, token);
			this.reconcile(id, loaded);
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			this.entries.get(id)!.summary.error = message;
			getLogger().error(`Failed to load ${fileName}: ${message}`);
			throw err;
		}
		return id;
	}

	/**
	 * Re-register a sample from persisted data without touching disk. Restore
	 * must not go through add(), which always parses; the cached counts are
	 * enough to draw the sidebar, and the matrix is read only when the sample
	 * is actually activated.
	 */
	adopt(sample: PersistedSample, error?: string): string {
		const uri = vscode.Uri.parse(sample.uri);
		const existing = this.has(uri);
		if (existing !== undefined) {
			return existing;
		}
		const id = sample.id;
		this.order.push(id);
		this.byUri.set(uri.toString(), id);
		this.entries.set(id, {
			uri,
			fileName: sample.fileName,
			summary: {
				id,
				fileName: sample.fileName,
				uri: sample.uri,
				eventCount: sample.eventCount,
				channelCount: sample.channelCount,
				...(sample.cytometer !== undefined ? { cytometer: sample.cytometer } : {}),
				...(error !== undefined ? { error } : {}),
			},
		});
		// Never let a later add() collide with an adopted id.
		const n = /^s(\d+)$/.exec(id);
		if (n) {
			this.nextId = Math.max(this.nextId, Number(n[1]) + 1);
		}
		return id;
	}

	remove(id: string): void {
		const i = this.order.indexOf(id);
		if (i >= 0) {
			this.order.splice(i, 1);
		}
		const entry = this.entries.get(id);
		if (entry) {
			this.byUri.delete(entry.uri.toString());
		}
		this.entries.delete(id);
	}

	/** Returns the parsed sample, re-reading from disk on a cache miss. */
	async load(id: string, token?: vscode.CancellationToken): Promise<LoadedSample> {
		const entry = this.entries.get(id);
		if (!entry) {
			throw new Error(`Unknown sample ${id}`);
		}
		const parsed = await this.cache.loadFile(entry.uri, token);
		return { id, uri: entry.uri, fileName: entry.fileName, dataset: parsed.dataset, stats: parsed.stats };
	}

	/** True when this sample's matrix is currently in memory. */
	isResident(id: string): boolean {
		const entry = this.entries.get(id);
		return entry !== undefined && this.cache.isResident(entry.uri);
	}

	/**
	 * Refresh a summary from a fresh parse. Adopted entries carry counts cached
	 * from a previous session, which go stale if the file changed on disk.
	 * Returns true when anything actually changed, so the caller can re-post.
	 */
	reconcile(id: string, loaded: LoadedSample): boolean {
		const entry = this.entries.get(id);
		if (!entry) {
			return false;
		}
		const meta = loaded.dataset.metadata;
		const next: SampleSummary = {
			id,
			fileName: entry.fileName,
			uri: entry.uri.toString(),
			eventCount: loaded.dataset.eventCount,
			channelCount: loaded.dataset.channelCount,
			...(meta.cytometer !== undefined ? { cytometer: meta.cytometer } : {}),
		};
		const changed =
			entry.summary.eventCount !== next.eventCount ||
			entry.summary.channelCount !== next.channelCount ||
			entry.summary.cytometer !== next.cytometer ||
			entry.summary.error !== undefined;
		entry.summary = next;
		return changed;
	}

	markFailed(id: string, message: string): void {
		const entry = this.entries.get(id);
		if (entry) {
			entry.summary = { ...entry.summary, error: message };
		}
	}

	/** Quantiles, computed lazily so the first paint is not blocked by them. */
	async computeQuantileStats(sample: LoadedSample): Promise<ChannelStats[]> {
		const parsed = this.cache.peek(sample.uri);
		if (!parsed) {
			return sample.stats;
		}
		return this.cache.computeQuantileStats(parsed);
	}

	/**
	 * Gather the subsample the webview renders. Only this crosses the wire.
	 *
	 * `requested === null` means every event. The caller is responsible for
	 * budget clamping; this just gathers what it is asked for.
	 */
	async slice(
		id: string,
		requested: number | null,
		requestId: number,
		token?: vscode.CancellationToken,
	): Promise<SampleSlice> {
		const entry = this.entries.get(id);
		if (!entry) {
			throw new Error(`Unknown sample ${id}`);
		}
		// Normally a cache hit, but a re-slice can miss -- and then this is a
		// full read and parse, which must be cancellable like any other.
		const parsed = await this.cache.loadFile(entry.uri, token);
		const { dataset } = parsed;
		const n = requested === null ? dataset.eventCount : Math.min(requested, dataset.eventCount);
		const gathered = gatherSlice(
			dataset.matrix,
			dataset.eventCount,
			dataset.channelCount,
			this.cache.permutationOf(parsed),
			n,
		);
		return {
			sampleId: id,
			requestId,
			sampledCount: gathered.count,
			eventCount: dataset.eventCount,
			channelCount: dataset.channelCount,
			matrix: new Uint8Array(gathered.values.buffer, gathered.values.byteOffset, gathered.values.byteLength),
			eventIds: new Uint8Array(gathered.eventIds.buffer, gathered.eventIds.byteOffset, gathered.eventIds.byteLength),
			seed: parsed.seed,
		};
	}

	/** Keep this sample's matrix resident; every re-slice depends on a hit. */
	pin(id: string): void {
		const uri = this.entries.get(id)?.uri;
		if (uri) {
			this.cache.pin(uri);
		}
	}

	/**
	 * Release the pin on a sample that is no longer active.
	 *
	 * A pin is only justified while a sample is the one being re-sliced.
	 * Holding it for the tab's whole lifetime keeps every file the user has
	 * ever clicked resident -- ten CyTOF samples is ~310 MB against a cache
	 * sized for three.
	 */
	unpin(id: string): void {
		const uri = this.entries.get(id)?.uri;
		if (uri) {
			this.cache.unpin(uri);
		}
	}

	isPinned(id: string): boolean {
		const uri = this.entries.get(id)?.uri;
		return uri !== undefined && this.cache.isPinned(uri);
	}

	unpinAll(): void {
		for (const e of this.entries.values()) {
			this.cache.unpin(e.uri);
		}
	}

	/** The shape persisted per tab, so a reload can adopt these back. */
	toPersisted(): PersistedSample[] {
		return this.order.map((id) => {
			const s = this.entries.get(id)!.summary;
			return {
				id,
				uri: s.uri,
				fileName: s.fileName,
				eventCount: s.eventCount,
				channelCount: s.channelCount,
				...(s.cytometer !== undefined ? { cytometer: s.cytometer } : {}),
			};
		});
	}

	private mintId(): string {
		return `s${this.nextId++}`;
	}

	dispose(): void {
		this.unpinAll();
		// Deliberately does NOT evict from matrixCache: another tab may be using it.
		this.entries.clear();
		this.byUri.clear();
		this.order.length = 0;
	}
}
