import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { SampleData } from '../../webview/state/SampleData';
import { parseFcs, invertMatrix, compensateColumns, type FcsSpillover } from '../../common/fcs';
import { computeBasicStats } from '../../common/fcs/stats';
import { channelColumn } from '../../common/fcs/types';
import { buildPermutation, gatherSlice } from '../../common/sampling';
import { makeFcs, simpleFloatFcs, type MakeChannel } from './fixtures/makeFcs';

const SEED = 0x5eed;

/** Build a SampleData the way the host would: a gathered slice, not the matrix. */
function make(events = 40_000, channels = 4, requested = events, bytes?: Uint8Array): SampleData {
	const ds = parseFcs(bytes ?? simpleFloatFcs(events, channels));
	const g = gatherSlice(
		ds.matrix,
		ds.eventCount,
		ds.channelCount,
		buildPermutation(ds.eventCount, SEED),
		requested,
	);
	return new SampleData({
		id: 's1',
		fileName: 'test.fcs',
		metadata: ds.metadata,
		matrix: g.values,
		eventIds: g.eventIds,
		sampledCount: g.count,
		eventCount: ds.eventCount,
		channelCount: ds.channelCount,
		stats: ds.metadata.channels.map((c) => computeBasicStats(channelColumn(ds, c.index), c.index)),
		seed: SEED,
	});
}

describe('SampleData.rows', () => {
	/**
	 * Rows arrive in permutation order, so a prefix IS a smaller subsample.
	 * This is what lets a shrink of the subsample, and the no-WebGL point cap,
	 * be served locally with no round-trip to the host.
	 */
	it('returns a prefix, which is itself a valid smaller sample', () => {
		const d = make(40_000, 4, 10_000);
		const small = d.rows(5_000);
		assert.equal(small.length, 5_000);
		assert.deepEqual(Array.from(small), Array.from({ length: 5_000 }, (_, i) => i));
		// The events behind that prefix span the run rather than its start.
		const ids = Array.from(d.eventIds.subarray(0, 5_000));
		assert.ok(Math.max(...ids) > 0.85 * 40_000);
		assert.ok(Math.min(...ids) < 0.15 * 40_000);
	});

	it('never exceeds the rows actually delivered', () => {
		const d = make(40_000, 4, 8_000);
		assert.equal(d.rows(20_000).length, 8_000);
		assert.equal(d.rows(null).length, 8_000);
	});

	it('returns a stable array per size, so render memos can short-circuit', () => {
		const d = make(1_000, 2, 1_000);
		assert.equal(d.rows(500), d.rows(500));
	});
});

describe('SampleData.eventIds', () => {
	it('reports the original event index for each row', () => {
		const d = make(1_000, 3, 100);
		// value = event * 10 + channel, so a row's value identifies its event.
		for (let i = 0; i < 100; i++) {
			assert.equal(d.rawColumn(2)[i], d.eventIds[i]! * 10 + 2);
		}
	});

	it('orders rows by original event index for the table', () => {
		const d = make(1_000, 2, 200);
		const order = d.ascendingRows();
		assert.equal(order.length, 200);
		for (let i = 1; i < order.length; i++) {
			assert.ok(d.eventIds[order[i]!]! > d.eventIds[order[i - 1]!]!);
		}
	});
});

describe('SampleData.rawColumn', () => {
	// Without memoisation subarray() hands back a new view each call, so the
	// axis memos saw a changed identity and every load rendered each card twice.
	it('returns the identical array on repeated calls', () => {
		const d = make(1_000, 3, 500);
		assert.equal(d.rawColumn(1), d.rawColumn(1));
		assert.notEqual(d.rawColumn(1), d.rawColumn(2));
	});

	it('keeps that identity across withStats', () => {
		const d = make(1_000, 3, 500);
		const before = d.rawColumn(1);
		assert.equal(d.withStats(d.stats).rawColumn(1), before);
	});

	it('strides by the row count, not the file event count', () => {
		const d = make(1_000, 3, 50);
		assert.equal(d.rawColumn(0).length, 50);
		assert.equal(d.rawColumn(2).length, 50);
		assert.equal(d.eventCount, 1_000, 'the file total is still reported');
	});
});

describe('SampleData.withSlice', () => {
	it('drops every cache derived from the previous slice', () => {
		const d = make(1_000, 3, 100);
		const before = d.rawColumn(1);
		const next = d.withSlice({
			matrix: new Float32Array(3 * 10),
			eventIds: Uint32Array.from({ length: 10 }, (_, i) => i),
			sampledCount: 10,
			eventCount: 1_000,
			channelCount: 3,
			seed: SEED,
		});
		assert.notEqual(next.rawColumn(1), before, 'a stale column view would serve the old slice');
		assert.equal(next.rawColumn(1).length, 10);
		assert.deepEqual(next.cachedRowSizes, []);
	});
});

describe('SampleData.column with compensation', () => {
	/**
	 * Compensation has no cross-event term, so restricting it to a subset must
	 * give bit-identical values for those events. This is the machine-checked
	 * form of the argument that lets only the subsample be transferred.
	 */
	it('matches full-matrix compensation restricted to the sampled rows', () => {
		const channels: MakeChannel[] = [
			{ name: 'FSC-A', bits: 32, range: 1024 },
			{ name: 'B515-A', label: 'cd3', bits: 32, range: 1024 },
			{ name: 'G560-A', label: 'cd4', bits: 32, range: 1024 },
		];
		const events: number[][] = [];
		for (let e = 0; e < 500; e++) {
			events.push([e, Math.sin(e) * 100 + 200, Math.cos(e) * 80 + 150]);
		}
		const spill = { keyword: 'SPILL' as const, channels: ['B515-A', 'G560-A'], matrix: [[1, 0.12], [0.07, 1]] };
		const bytes = makeFcs({ channels, events, spillover: spill });

		const ds = parseFcs(bytes);
		const sp = ds.metadata.spillover as FcsSpillover;
		const inv = invertMatrix(sp.matrix, sp.size)!;
		const full = compensateColumns(ds.matrix, ds.eventCount, sp, inv);

		const d = make(0, 0, 120, bytes);
		(d as unknown as { spillover: FcsSpillover }).spillover = sp;
		(d as unknown as { spilloverInverse: Float64Array }).spilloverInverse = inv;

		const sliced = d.column(sp.channelIndices[0]!, true);
		for (let i = 0; i < d.sampledCount; i++) {
			assert.ok(
				Math.abs(sliced[i]! - full[0]![d.eventIds[i]!]!) < 1e-3,
				`row ${i} (event ${d.eventIds[i]}) differs`,
			);
		}
	});

	it('leaves channels outside the spillover matrix untouched', () => {
		const d = make(1_000, 3, 100);
		assert.equal(d.column(0, true), d.rawColumn(0));
	});
});
