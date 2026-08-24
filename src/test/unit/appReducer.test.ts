import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { initialState, reducer, type Action, type AppState } from '../../webview/state/appReducer';
import { SampleData } from '../../webview/state/SampleData';
import { parseFcs, invertMatrix, type FcsSpillover } from '../../common/fcs';
import { computeBasicStats } from '../../common/fcs/stats';
import { channelColumn } from '../../common/fcs/types';
import { buildPermutation, gatherSlice } from '../../common/sampling';
import { makeFcs, type MakeChannel } from './fixtures/makeFcs';

const SEED = 0x5eed;

const CHANNELS: MakeChannel[] = [
	{ name: 'FSC-A', bits: 32, range: 1024 },
	{ name: 'B515-A', label: 'cd3', bits: 32, range: 1024 },
	{ name: 'G560-A', label: 'cd4', bits: 32, range: 1024 },
];

/** A sample the way the host delivers one, with or without a spillover matrix. */
function sample(id: string, withSpillover: boolean): SampleData {
	const events = Array.from({ length: 50 }, (_, e) => [e, e * 2, e * 3]);
	const bytes = makeFcs({
		channels: CHANNELS,
		events,
		...(withSpillover
			? { spillover: { keyword: '$SPILLOVER' as const, channels: ['B515-A', 'G560-A'], matrix: [[1, 0.12], [0.07, 1]] } }
			: {}),
	});
	const ds = parseFcs(bytes);
	const g = gatherSlice(ds.matrix, ds.eventCount, ds.channelCount, buildPermutation(ds.eventCount, SEED), 50);
	const sp = ds.metadata.spillover;
	return new SampleData({
		id,
		fileName: `${id}.fcs`,
		metadata: ds.metadata,
		matrix: g.values,
		eventIds: g.eventIds,
		sampledCount: g.count,
		eventCount: ds.eventCount,
		channelCount: ds.channelCount,
		stats: ds.metadata.channels.map((c) => computeBasicStats(channelColumn(ds, c.index), c.index)),
		seed: SEED,
		...(sp ? { spillover: sp as FcsSpillover, spilloverInverse: invertMatrix(sp.matrix, sp.size)! } : {}),
	});
}

function load(state: AppState, data: SampleData): AppState {
	const action: Action = {
		type: 'sampleLoaded',
		data,
		activationId: state.activationId,
		defaults: { sampleSize: 5000, cofactor: 150 },
		maxSliceBytes: 64 * 1024 * 1024,
	};
	return reducer(state, action);
}

describe('compensation across samples', () => {
	const compensatable = sample('s1', true);
	const plain = sample('s2', false);

	it('is a global setting that survives a sample without a matrix', () => {
		let state = load(initialState(), compensatable);
		state = reducer(state, { type: 'setCompensate', on: true });
		assert.equal(state.compensate, true);
		assert.equal(state.data?.canCompensate, true);

		// Used to be forced off here, which then persisted after switching
		// back: the plots were raw while the checkbox told a longer story.
		state = load(state, plain);
		assert.equal(state.compensate, true, 'the setting is the user\'s intent, not a property of the sample');
		assert.equal(state.data?.canCompensate, false);
		// Nothing is actually compensated, because the values fall through.
		assert.deepEqual(
			Array.from(state.data!.column(1, true)),
			Array.from(state.data!.column(1, false)),
		);

		state = load(state, compensatable);
		assert.equal(state.compensate, true);
		assert.notDeepEqual(
			Array.from(state.data!.column(1, true)),
			Array.from(state.data!.column(1, false)),
			'and it takes effect again on a sample that has a matrix',
		);
	});

	it('still turns off when the user turns it off', () => {
		let state = load(initialState(), compensatable);
		state = reducer(state, { type: 'setCompensate', on: true });
		state = reducer(state, { type: 'setCompensate', on: false });
		assert.equal(state.compensate, false);
	});
});
