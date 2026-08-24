import { forward, type TransformSpec } from '../../common/fcs/transform';
import type { ChannelKind } from '../../common/fcs/types';

/**
 * Turning a slice into something UMAP can consume.
 *
 * Kept separate from the card and the hook because this is the part that
 * decides whether the embedding means anything, and it is the part that is
 * silently wrong rather than visibly broken when it is not right.
 */

/** umap-js wants row-major nested arrays; it has no typed-array entry point. */
export type Vectors = number[][];

export interface EmbeddingChannel {
	/** Column index in the event matrix. */
	index: number;
	/** Values for the sampled rows, already compensated if that is on. */
	values: Float32Array;
	kind: ChannelKind;
	/** arsinh cofactor, used only when the channel's default transform is arsinh. */
	cofactor: number;
}

/**
 * The same per-channel choice the plot cards make: FSC/SSC and Time are
 * already linear, everything else is fluorescence or metal intensity and wants
 * arsinh. Duplicated in spirit from the reducer's defaultTransformFor, but
 * expressed over a TransformSpec so the numeric path is exactly `forward`.
 */
export function defaultSpecFor(kind: ChannelKind, cofactor: number): TransformSpec {
	return { kind: kind === 'time' || kind === 'scatter' ? 'linear' : 'arsinh', cofactor };
}

function specFor(channel: EmbeddingChannel): TransformSpec {
	return defaultSpecFor(channel.kind, channel.cofactor);
}

/**
 * Pack the selected channels for the given rows into UMAP's input shape,
 * transformed and standardised.
 *
 * **The standardisation is not cosmetic.** UMAP's neighbour graph is built on
 * Euclidean distance, so a channel is weighted by its numeric spread. Raw FSC
 * runs to 10^5 while an arsinh-transformed marker spans single digits: without
 * scaling, the embedding is essentially a plot of FSC and the markers
 * contribute rounding error. Centring and scaling each channel to unit
 * variance gives every channel an equal vote, which is what anyone reading a
 * UMAP of a cytometry panel assumes has happened.
 *
 * A channel with no variance (a constant, which happens with an unused
 * detector) would divide by zero, so it is left centred at zero instead of
 * being scaled to NaN -- one NaN would poison every distance.
 */
export function packForEmbedding(rows: Uint32Array, channels: EmbeddingChannel[]): Vectors {
	const n = rows.length;
	const k = channels.length;
	const out: Vectors = Array.from({ length: n }, () => new Array<number>(k).fill(0));

	for (let c = 0; c < k; c++) {
		const channel = channels[c]!;
		const spec = specFor(channel);
		const values = channel.values;

		// Transform first, then measure: the mean and variance that matter are
		// the ones in the space the distance is computed in.
		const column = new Float64Array(n);
		let sum = 0;
		for (let i = 0; i < n; i++) {
			const v = forward(values[rows[i]!]!, spec);
			// A non-finite input (log of a negative, or a NaN in the file)
			// cannot be placed; treat it as the channel mean by zeroing it
			// after centring, which is the least-worst option and keeps the
			// point in the embedding rather than dropping the whole event.
			const finite = Number.isFinite(v) ? v : 0;
			column[i] = finite;
			sum += finite;
		}

		const mean = sum / (n || 1);
		let ss = 0;
		for (let i = 0; i < n; i++) {
			const d = column[i]! - mean;
			ss += d * d;
		}
		const sd = Math.sqrt(ss / (n || 1));
		const scale = sd > 1e-12 ? 1 / sd : 0;

		for (let i = 0; i < n; i++) {
			out[i]![c] = (column[i]! - mean) * scale;
		}
	}
	return out;
}

/**
 * Identity of an embedding: everything that legitimately invalidates it, and
 * nothing that does not.
 *
 * Colour, colormap and point size are deliberately absent. Recolouring a UMAP
 * must not throw away a computation that took seconds, and keeping that
 * guarantee in one function is what makes it testable.
 */
export function embeddingSignature(input: {
	sampleId: string;
	channels: number[];
	nNeighbors: number;
	minDist: number;
	cells: number;
	compensate: boolean;
	/**
	 * The arsinh cofactor the channels are transformed with. Part of the
	 * identity: it changes the space the distances are measured in, so
	 * leaving it out would keep serving an embedding of a different space.
	 */
	cofactor: number;
	seed: number;
}): string {
	return [
		input.sampleId,
		[...input.channels].sort((a, b) => a - b).join(','),
		input.nNeighbors,
		input.minDist,
		input.cells,
		input.compensate ? 'comp' : 'raw',
		input.cofactor,
		input.seed,
	].join('|');
}
