import { useEffect, useRef, useState } from 'react';
import { UMAP } from 'umap-js';
import { mulberry32 } from '../../common/sampling';
import { afterPaint } from '../render/drawQueue';
import { embeddingSignature, packForEmbedding, type EmbeddingChannel } from '../compute/embedding';

/**
 * Runs UMAP without freezing the window, and without recomputing when it does
 * not have to.
 *
 * umap-js also offers `fitAsync`, which yields once per epoch. This drives
 * `initializeFit` + `step()` directly instead, for two reasons: epochs cost
 * about 1.3 ms at a thousand cells, so one macrotask each spends more time in
 * the scheduler than in UMAP, and `fitAsync` hides `initializeFit` -- the one
 * genuinely blocking part -- inside the same call, leaving no chance to paint
 * a "preparing" state before the window stalls for it.
 *
 * There is no `transform()` step. Fitting a subsample and then projecting the
 * rest costs about half a second of unavoidable, unyieldable nearest-neighbour
 * search, which is worse than the thing it buys. The card plots exactly the
 * cells it embedded, and says how many.
 */

/** Milliseconds of work per frame. Below a 16 ms frame, leaving room to paint. */
const SLICE_MS = 12;

/** How many embeddings to keep. Enough to flip between two samples for free. */
const CACHE_SIZE = 4;

export interface EmbeddingRequest {
	sampleId: string;
	/** Rows to embed, a prefix of the shared subsample. */
	rows: Uint32Array;
	channels: EmbeddingChannel[];
	nNeighbors: number;
	minDist: number;
	compensate: boolean;
	seed: number;
}

export interface EmbeddingResult {
	/** Two coordinates per row, parallel to `rows`. */
	xy: Float64Array;
	cells: number;
}

export type EmbeddingState =
	| { status: 'idle' }
	| { status: 'preparing' }
	| { status: 'running'; epoch: number; total: number; partial: EmbeddingResult }
	| { status: 'done'; result: EmbeddingResult }
	| { status: 'failed'; message: string };

const cache = new Map<string, EmbeddingResult>();

function remember(key: string, value: EmbeddingResult): void {
	cache.delete(key);
	cache.set(key, value);
	for (const oldest of [...cache.keys()]) {
		if (cache.size <= CACHE_SIZE) {
			break;
		}
		cache.delete(oldest);
	}
}

/** Test hook: this module holds state shared by every card. */
export function resetEmbeddingCache(): void {
	cache.clear();
}

function toXY(embedding: number[][]): Float64Array {
	const xy = new Float64Array(embedding.length * 2);
	for (let i = 0; i < embedding.length; i++) {
		const p = embedding[i]!;
		xy[i * 2] = p[0] ?? 0;
		xy[i * 2 + 1] = p[1] ?? 0;
	}
	return xy;
}

export function useUmapEmbedding(request: EmbeddingRequest | undefined): EmbeddingState {
	const signature = request
		? embeddingSignature({
			sampleId: request.sampleId,
			channels: request.channels.map((c) => c.index),
			nNeighbors: request.nNeighbors,
			minDist: request.minDist,
			cells: request.rows.length,
			compensate: request.compensate,
			// Every channel carries the same cofactor; the card builds them.
			cofactor: request.channels[0]?.cofactor ?? 0,
			seed: request.seed,
		})
		: undefined;

	// Only the asynchronous run is state; "idle", "cached" and the initial
	// "preparing" are all derivable from the signature, and deriving them keeps
	// the effect from setting state synchronously on every render.
	const [run, setRun] = useState<{ key: string; state: EmbeddingState } | undefined>();

	// The effect keys off the signature alone. The request object behind it is
	// rebuilt on unrelated renders, and restarting a fit because an array got a
	// new identity would throw away seconds of work.
	const latest = useRef(request);
	useEffect(() => {
		latest.current = request;
	});

	useEffect(() => {
		const current = latest.current;
		if (!current || signature === undefined || cache.has(signature)) {
			return;
		}

		let cancelled = false;
		const request = current;

		// initializeFit blocks for roughly 180 ms at a thousand cells and
		// cannot be broken up, so the "preparing" state -- which is what the
		// caller derives while no run exists -- gets a chance to paint first.
		afterPaint(() => {
			if (cancelled) {
				return;
			}
			let umap: UMAP;
			let total: number;
			try {
				umap = new UMAP({
					nNeighbors: Math.min(request.nNeighbors, Math.max(2, request.rows.length - 1)),
					minDist: request.minDist,
					nComponents: 2,
					// Seeded, so the same card gives the same layout twice. An
					// embedding that moved on every recompute would be unusable
					// for comparing two samples.
					random: mulberry32(request.seed),
				});
				total = umap.initializeFit(packForEmbedding(request.rows, request.channels));
			} catch (err) {
				setRun({ key: signature, state: { status: 'failed', message: err instanceof Error ? err.message : String(err) } });
				return;
			}

			const pump = (): void => {
				if (cancelled) {
					return;
				}
				const started = performance.now();
				let epoch = 0;
				try {
					// Several epochs per frame: one per frame would cap the run
					// at 60 epochs a second for work that costs ~1.3 ms.
					do {
						epoch = umap.step();
					} while (epoch < total && performance.now() - started < SLICE_MS);
				} catch (err) {
					setRun({ key: signature, state: { status: 'failed', message: err instanceof Error ? err.message : String(err) } });
					return;
				}

				const result: EmbeddingResult = { xy: toXY(umap.getEmbedding()), cells: request.rows.length };
				if (epoch >= total) {
					remember(signature, result);
					setRun({ key: signature, state: { status: 'done', result } });
					return;
				}
				setRun({ key: signature, state: { status: 'running', epoch, total, partial: result } });
				afterPaint(pump);
			};
			afterPaint(pump);
		});

		return () => {
			cancelled = true;
		};
	}, [signature]);

	if (signature === undefined) {
		return { status: 'idle' };
	}
	const cached = cache.get(signature);
	if (cached) {
		return { status: 'done', result: cached };
	}
	return run?.key === signature ? run.state : { status: 'preparing' };
}
