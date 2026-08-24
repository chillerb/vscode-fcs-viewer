import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseFcs, invertMatrix, compensateColumns, type FcsSpillover } from '../../common/fcs';
import { makeFcs, type MakeChannel } from './fixtures/makeFcs';

const CH: MakeChannel[] = [
	{ name: 'FSC-A', bits: 32, range: 1024 },
	{ name: 'B515-A', label: 'cd3', bits: 32, range: 1024 },
	{ name: 'G560-A', label: 'cd4', bits: 32, range: 1024 },
	{ name: 'Time', bits: 32, range: 1024 },
];

const SPILL = { channels: ['B515-A', 'G560-A'], matrix: [[1, 0.1], [0.05, 1]] };

describe('spillover parsing', () => {
	for (const keyword of ['$SPILLOVER', '$SPILL', 'SPILL'] as const) {
		it(`accepts the ${keyword} keyword`, () => {
			const ds = parseFcs(makeFcs({ channels: CH, events: [[1, 2, 3, 4]], spillover: { keyword, ...SPILL } }));
			const sp = ds.metadata.spillover;
			assert.ok(sp, `${keyword} should be recognised`);
			assert.equal(sp.source, keyword);
			assert.equal(sp.size, 2);
			assert.deepEqual(sp.channelIndices, [1, 2], 'names must resolve to matrix column indices');
		});
	}

	it('ignores a matrix with the wrong token count', () => {
		const bytes = makeFcs({ channels: CH, events: [[1, 2, 3, 4]], extraKeywords: { SPILL: '2,B515-A,G560-A,1,0.1,0.05' } });
		const ds = parseFcs(bytes);
		assert.equal(ds.metadata.spillover, undefined);
		assert.ok(ds.metadata.warnings.some((w) => w.code === 'SPILLOVER_INVALID'));
	});

	it('ignores a matrix naming an unknown channel', () => {
		const ds = parseFcs(makeFcs({ channels: CH, events: [[1, 2, 3, 4]], spillover: { channels: ['B515-A', 'NOPE-A'], matrix: [[1, 0], [0, 1]] } }));
		assert.equal(ds.metadata.spillover, undefined);
		assert.ok(ds.metadata.warnings.some((w) => w.code === 'SPILLOVER_INVALID'));
	});

	it('reports no spillover when the file has none', () => {
		const ds = parseFcs(makeFcs({ channels: CH, events: [[1, 2, 3, 4]] }));
		assert.equal(ds.metadata.spillover, undefined);
	});
});

describe('invertMatrix', () => {
	it('inverts to within float tolerance', () => {
		const m = Float64Array.from([1, 0.1, 0.05, 1]);
		const inv = invertMatrix(m, 2);
		assert.ok(inv);
		// m * inv should be the identity.
		for (let i = 0; i < 2; i++) {
			for (let j = 0; j < 2; j++) {
				let sum = 0;
				for (let k = 0; k < 2; k++) {
					sum += m[i * 2 + k]! * inv[k * 2 + j]!;
				}
				assert.ok(Math.abs(sum - (i === j ? 1 : 0)) < 1e-12);
			}
		}
	});

	it('returns undefined for a singular matrix', () => {
		assert.equal(invertMatrix(Float64Array.from([1, 2, 2, 4]), 2), undefined);
	});
});

describe('compensateColumns', () => {
	it('undoes a known spillover', () => {
		// Build events whose observed values are true values run through S.
		const truth = [[100, 0], [0, 100], [50, 50]];
		const S = [[1, 0.1], [0.05, 1]];
		const observed = truth.map(([a, b]) => [a! * S[0]![0]! + b! * S[1]![0]!, a! * S[0]![1]! + b! * S[1]![1]!]);
		const events = observed.map(([b515, g560], i) => [1, b515!, g560!, i]);

		const ds = parseFcs(makeFcs({ channels: CH, events, spillover: { keyword: 'SPILL', channels: ['B515-A', 'G560-A'], matrix: S } }));
		const sp = ds.metadata.spillover as FcsSpillover;
		const inv = invertMatrix(sp.matrix, sp.size)!;
		const cols = compensateColumns(ds.matrix, ds.eventCount, sp, inv);

		for (let e = 0; e < truth.length; e++) {
			assert.ok(Math.abs(cols[0]![e]! - truth[e]![0]!) < 1e-3, `event ${e} channel 0`);
			assert.ok(Math.abs(cols[1]![e]! - truth[e]![1]!) < 1e-3, `event ${e} channel 1`);
		}
	});

	it('leaves channels outside the matrix untouched', () => {
		const events = [[11, 2, 3, 44], [12, 5, 6, 45]];
		const ds = parseFcs(makeFcs({ channels: CH, events, spillover: { keyword: 'SPILL', ...SPILL } }));
		const sp = ds.metadata.spillover as FcsSpillover;
		const inv = invertMatrix(sp.matrix, sp.size)!;
		compensateColumns(ds.matrix, ds.eventCount, sp, inv);

		// FSC-A (index 0) and Time (index 3) are outside SPILL and must be
		// bit-identical after compensation.
		assert.equal(ds.matrix[0 * 2 + 0], 11);
		assert.equal(ds.matrix[0 * 2 + 1], 12);
		assert.equal(ds.matrix[3 * 2 + 0], 44);
		assert.equal(ds.matrix[3 * 2 + 1], 45);
	});
});
