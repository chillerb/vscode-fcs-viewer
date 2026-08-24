import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseFcs, invertMatrix } from '../../common/fcs';
import { computeBasicStats } from '../../common/fcs/stats';
import { channelColumn } from '../../common/fcs/types';
import { PROTOCOL_VERSION, type ActiveSamplePayload } from '../../common/protocol';
import { buildPermutation, gatherSlice } from '../../common/sampling';
import { makeFcs } from './fixtures/makeFcs';

function buildPayload(): ActiveSamplePayload {
	const ds = parseFcs(makeFcs({
		channels: [
			{ name: 'B515-A', label: 'cd3', bits: 32, range: 1024 },
			{ name: 'G560-A', label: 'cd4', bits: 32, range: 1024 },
		],
		events: [[1, 2], [3, 4], [5, 6]],
		extraKeywords: { $CYT: 'LSRII' },
		spillover: { keyword: 'SPILL', channels: ['B515-A', 'G560-A'], matrix: [[1, 0.1], [0.05, 1]] },
	}));
	const stats = ds.metadata.channels.map((c) => computeBasicStats(channelColumn(ds, c.index), c.index));
	const sp = ds.metadata.spillover!;
	const g = gatherSlice(
		ds.matrix,
		ds.eventCount,
		ds.channelCount,
		buildPermutation(ds.eventCount, 0x5eed),
		2,
	);
	return {
		id: 's1',
		activationId: 1,
		fileName: 'test.fcs',
		uri: 'file:///test.fcs',
		metadata: ds.metadata,
		slice: {
			sampleId: 's1',
			requestId: 0,
			sampledCount: g.count,
			eventCount: ds.eventCount,
			channelCount: ds.channelCount,
			matrix: new Uint8Array(g.values.buffer, g.values.byteOffset, g.values.byteLength),
			eventIds: new Uint8Array(g.eventIds.buffer, g.eventIds.byteOffset, g.eventIds.byteLength),
			seed: 0x5eed,
		},
		stats,
		spillover: sp,
		spilloverInverse: invertMatrix(sp.matrix, sp.size)!,
		defaults: { sampleSize: 5000, cofactor: 150 },
		maxSliceBytes: 16 * 1024 * 1024,
	};
}

describe('protocol payload', () => {
	it('survives structuredClone, which is what postMessage does', () => {
		const payload = buildPayload();
		const cloned = structuredClone(payload);
		assert.equal(cloned.slice.eventCount, 3, 'the FILE total travels, not the row count');
		assert.equal(cloned.slice.sampledCount, 2);
		assert.ok(cloned.slice.matrix instanceof Uint8Array, 'the matrix must arrive as a typed array');
		assert.ok(cloned.slice.eventIds instanceof Uint8Array, 'so must the event ids');
		assert.equal(cloned.slice.matrix.byteLength, payload.slice.matrix.byteLength);
		assert.ok(cloned.spilloverInverse instanceof Float64Array);
		assert.equal(cloned.metadata.channels[0]!.label, 'cd3');
	});

	it('reconstructs the sampled values and their event ids on the far side', () => {
		const payload = buildPayload();
		const cloned = structuredClone(payload);
		const u8 = cloned.slice.matrix;
		const matrix = u8.byteOffset % 4 === 0
			? new Float32Array(u8.buffer, u8.byteOffset, u8.byteLength / 4)
			: new Float32Array(u8.slice().buffer);
		const ids8 = cloned.slice.eventIds;
		const eventIds = ids8.byteOffset % 4 === 0
			? new Uint32Array(ids8.buffer, ids8.byteOffset, ids8.byteLength / 4)
			: new Uint32Array(ids8.slice().buffer);

		const rows = cloned.slice.sampledCount;
		assert.equal(matrix.length, rows * 2);
		assert.equal(eventIds.length, rows);
		// Fixture values are event*2+1 on channel 1 (events [[1,2],[3,4],[5,6]]).
		for (let i = 0; i < rows; i++) {
			assert.equal(matrix[1 * rows + i], eventIds[i]! * 2 + 2);
		}
	});

	it('contains no Map, Set or class instance that a JSON transport would drop', () => {
		const seen = new Set<unknown>();
		const check = (v: unknown, path: string): void => {
			if (v === null || typeof v !== 'object' || seen.has(v)) {
				return;
			}
			seen.add(v);
			assert.ok(!(v instanceof Map), `Map at ${path}`);
			assert.ok(!(v instanceof Set), `Set at ${path}`);
			if (ArrayBuffer.isView(v) || Array.isArray(v)) {
				return;
			}
			const proto = Object.getPrototypeOf(v);
			assert.ok(proto === Object.prototype || proto === null, `class instance at ${path}`);
			for (const [k, child] of Object.entries(v)) {
				check(child, `${path}.${k}`);
			}
		};
		check(buildPayload(), 'payload');
	});

	it('pins the protocol version', () => {
		// 2: the wire carried a subsample instead of the whole matrix.
		// 3: the activation payload gained an id, so a superseded sample
		//    switch can be recognised and dropped.
		assert.equal(PROTOCOL_VERSION, 3);
	});
});
