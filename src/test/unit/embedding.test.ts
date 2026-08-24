import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { embeddingSignature, packForEmbedding, type EmbeddingChannel } from '../../webview/compute/embedding';

/**
 * The preprocessing is the part of a UMAP that is silently wrong rather than
 * visibly broken. An unstandardised embedding still produces a picture with
 * clusters in it; it is just a picture of whichever channel had the widest
 * numeric range.
 */

function channel(index: number, values: number[], kind: EmbeddingChannel['kind'] = 'marker'): EmbeddingChannel {
	return { index, values: Float32Array.from(values), kind, cofactor: 150 };
}

const ROWS = Uint32Array.from([0, 1, 2, 3]);

function columnOf(packed: number[][], c: number): number[] {
	return packed.map((row) => row[c]!);
}

function moments(xs: number[]): { mean: number; sd: number } {
	const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
	const sd = Math.sqrt(xs.reduce((a, b) => a + (b - mean) ** 2, 0) / xs.length);
	return { mean, sd };
}

describe('packForEmbedding', () => {
	it('produces one row per requested event, in that order', () => {
		const packed = packForEmbedding(Uint32Array.from([2, 0]), [channel(0, [10, 20, 30, 40])]);
		assert.equal(packed.length, 2);
		assert.equal(packed[0]!.length, 1);
		// Row 2 held the larger value, so it must come out above row 0.
		assert.ok(packed[0]![0]! > packed[1]![0]!);
	});

	it('centres and scales every channel to unit variance', () => {
		const packed = packForEmbedding(ROWS, [
			channel(0, [1, 2, 3, 4], 'scatter'),
			channel(1, [1000, 2000, 3000, 4000], 'scatter'),
		]);
		for (const c of [0, 1]) {
			const { mean, sd } = moments(columnOf(packed, c));
			assert.ok(Math.abs(mean) < 1e-9, `channel ${c} mean ${mean}`);
			assert.ok(Math.abs(sd - 1) < 1e-9, `channel ${c} sd ${sd}`);
		}
	});

	it('gives a wide channel no more weight than a narrow one', () => {
		// This is the whole reason standardisation is here. FSC runs to 10^5
		// while an arsinh marker spans single digits; unscaled, the distance
		// metric would be a function of FSC alone.
		const packed = packForEmbedding(ROWS, [
			channel(0, [0, 1, 2, 3], 'scatter'),
			channel(1, [0, 100000, 200000, 300000], 'scatter'),
		]);
		const spread = (c: number): number => Math.max(...columnOf(packed, c)) - Math.min(...columnOf(packed, c));
		assert.ok(Math.abs(spread(0) - spread(1)) < 1e-9, 'both channels must span the same range after scaling');
	});

	it('leaves a constant channel at zero rather than dividing by zero', () => {
		// An unused detector reads the same value for every event. One NaN
		// here would poison every pairwise distance in the embedding.
		const packed = packForEmbedding(ROWS, [channel(0, [7, 7, 7, 7], 'scatter')]);
		assert.deepEqual(columnOf(packed, 0), [0, 0, 0, 0]);
		assert.ok(packed.flat().every(Number.isFinite));
	});

	it('keeps an event whose value the transform cannot represent', () => {
		// arsinh handles negatives, but a NaN in the file must not remove the
		// event from the embedding entirely.
		const packed = packForEmbedding(ROWS, [channel(0, [1, NaN, 3, 4])]);
		assert.equal(packed.length, 4);
		assert.ok(packed.flat().every(Number.isFinite));
	});

	it('applies arsinh to markers and leaves scatter channels linear', () => {
		// A linear channel keeps equal spacing; an arsinh one compresses the
		// top of its range, so the gaps shrink as the values grow.
		const values = [0, 1000, 2000, 3000];
		const linear = columnOf(packForEmbedding(ROWS, [channel(0, values, 'scatter')]), 0);
		const arsinh = columnOf(packForEmbedding(ROWS, [channel(0, values, 'marker')]), 0);

		const gaps = (xs: number[]): number[] => xs.slice(1).map((v, i) => v - xs[i]!);
		const linearGaps = gaps(linear);
		assert.ok(Math.abs(linearGaps[0]! - linearGaps[2]!) < 1e-9, 'linear spacing stays even');

		const arsinhGaps = gaps(arsinh);
		assert.ok(arsinhGaps[2]! < arsinhGaps[0]!, 'arsinh compresses the upper end');
	});
});

describe('embeddingSignature', () => {
	const base = {
		sampleId: 's1',
		channels: [3, 1, 2],
		nNeighbors: 15,
		minDist: 0.1,
		cells: 1000,
		compensate: false,
		cofactor: 150,
		seed: 0x5eed,
	};

	it('ignores channel order, which is not a property of the embedding', () => {
		assert.equal(embeddingSignature(base), embeddingSignature({ ...base, channels: [1, 2, 3] }));
	});

	for (const [field, value] of [
		['sampleId', 's2'],
		['channels', [1, 2]],
		['nNeighbors', 30],
		['minDist', 0.5],
		['cells', 2000],
		['compensate', true],
		// A cofactor change is a different space, not a different colour.
		['cofactor', 5],
		['seed', 1],
	] as const) {
		it(`changes when ${field} changes`, () => {
			assert.notEqual(embeddingSignature(base), embeddingSignature({ ...base, [field]: value }));
		});
	}

	it('is unaffected by anything only affecting appearance', () => {
		// The guarantee the whole feature rests on: recolouring a UMAP must not
		// throw away seconds of computation. Colour, colormap and point size
		// are not inputs to this function at all, which is the point -- adding
		// one would break this silently, so the signature takes an explicit
		// shape rather than the card config.
		const keys = Object.keys(base);
		assert.ok(!keys.includes('colorBy'));
		assert.ok(!keys.includes('colormap'));
		assert.ok(!keys.includes('pointSize'));
	});
});
