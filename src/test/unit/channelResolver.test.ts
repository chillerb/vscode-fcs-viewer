import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseFcs } from '../../common/fcs';
import {
	buildIndex,
	channelRef,
	colorChoices,
	projectionRows,
	resolveChannel,
	summariseMapping,
	type ChannelRef,
} from '../../webview/state/channelResolver';
import { makeFcs, type MakeChannel } from './fixtures/makeFcs';

function meta(channels: MakeChannel[]) {
	return parseFcs(makeFcs({ channels, events: [channels.map(() => 1)] })).metadata;
}

const PANEL_A: MakeChannel[] = [
	{ name: 'FSC-A', bits: 32, range: 1024 },
	{ name: 'R780-A', label: 'cd3', bits: 32, range: 1024 },
	{ name: 'G710-A', label: 'cd4', bits: 32, range: 1024 },
];

describe('resolveChannel', () => {
	const index = buildIndex(meta(PANEL_A));

	it('resolves when index, $PnN and $PnS all match', () => {
		const r = resolveChannel({ name: 'R780-A', label: 'cd3', index: 1 }, index);
		assert.equal(r.channel?.name, 'R780-A');
		assert.equal(r.method, 'exact');
		assert.equal(r.approximate, false);
	});

	it('resolves a channel that has no label', () => {
		const r = resolveChannel({ name: 'FSC-A', index: 0 }, index);
		assert.equal(r.channel?.name, 'FSC-A');
	});

	// Matching is deliberately strict: a near-match is far more likely to be a
	// different marker than the same one, and plotting the wrong marker
	// silently is the worst outcome available.
	it('refuses a case- or punctuation-different name', () => {
		const messy = buildIndex(meta([{ name: 'cd_3', bits: 32, range: 1024 }]));
		assert.equal(resolveChannel({ name: 'CD3', index: 0 }, messy).channel, undefined);
	});

	it('refuses when the label differs', () => {
		assert.equal(resolveChannel({ name: 'R780-A', label: 'CD3', index: 1 }, index).channel, undefined);
	});

	it('refuses when the label is missing on one side', () => {
		assert.equal(resolveChannel({ name: 'R780-A', index: 1 }, index).channel, undefined);
	});

	it('refuses when the same channel sits at a different index', () => {
		assert.equal(resolveChannel({ name: 'R780-A', label: 'cd3', index: 2 }, index).channel, undefined);
	});

	it('refuses to guess when nothing matches', () => {
		const r = resolveChannel({ name: 'Nd143Di', label: '143Nd_CD49b', index: 1 }, index);
		assert.equal(r.channel, undefined, 'a wrong channel is worse than none');
	});

	it('honours a manual remapping', () => {
		const manual = new Map([['Nd143Di', 2]]);
		const r = resolveChannel({ name: 'Nd143Di', index: 0 }, index, manual);
		assert.equal(r.channel?.name, 'G710-A');
		assert.equal(r.method, 'manual');
	});
});

describe('summariseMapping', () => {
	it('reports what resolved and what did not', () => {
		const index = buildIndex(meta(PANEL_A));
		const refs: ChannelRef[] = [
			{ name: 'R780-A', label: 'cd3', index: 1 },
			{ name: 'cd_4', label: 'cd4', index: 2 },
			{ name: 'Nd143Di', index: 3 },
		];
		const report = summariseMapping(refs, index);
		assert.equal(report.total, 3);
		assert.equal(report.resolved, 1);
		assert.deepEqual(report.unresolved.sort(), ['Nd143Di', 'cd_4']);
	});

	it('deduplicates repeated references', () => {
		const index = buildIndex(meta(PANEL_A));
		const report = summariseMapping(
			[{ name: 'R780-A', label: 'cd3', index: 1 }, { name: 'R780-A', label: 'cd3', index: 1 }],
			index,
		);
		assert.equal(report.total, 1);
	});
});

describe('channelRef', () => {
	it('captures name, label and index together', () => {
		const m = meta(PANEL_A);
		const ref = channelRef(m.channels[1]!);
		assert.deepEqual(ref, { name: 'R780-A', label: 'cd3', index: 1 });
	});
});

describe('projectionRows', () => {
	const PANEL_B: MakeChannel[] = [
		{ name: 'FSC-A', bits: 32, range: 1024 },
		{ name: 'V450-A', label: 'cd8', bits: 32, range: 1024 },
	];

	it('lists the selected channels first, then the rest of the sample', () => {
		const index = buildIndex(meta(PANEL_A));
		const selected: ChannelRef[] = [{ name: 'R780-A', label: 'cd3', index: 1 }];
		const rows = projectionRows(selected, meta(PANEL_A).channels, index);
		assert.deepEqual(rows.map((r) => r.ref.name), ['R780-A', 'FSC-A', 'G710-A']);
		assert.deepEqual(rows.map((r) => r.on), [true, false, false]);
		assert.ok(rows.every((r) => r.present));
	});

	// The whole point: a selected channel the current sample lacks stays on the
	// list so it can be unticked. Hiding it would leave the card permanently
	// refusing to compute with no way to fix it from the inspector.
	it('keeps a selected channel the current sample does not have', () => {
		const index = buildIndex(meta(PANEL_B));
		const selected: ChannelRef[] = [
			{ name: 'R780-A', label: 'cd3', index: 1 },
			{ name: 'FSC-A', index: 0 },
		];
		const rows = projectionRows(selected, meta(PANEL_B).channels, index);
		assert.deepEqual(rows.map((r) => r.ref.name), ['R780-A', 'FSC-A', 'V450-A']);
		assert.deepEqual(rows.map((r) => r.present), [false, true, true]);
		assert.deepEqual(rows.map((r) => r.on), [true, true, false]);
	});

	it('does not offer a sample channel twice when it is already selected', () => {
		const index = buildIndex(meta(PANEL_A));
		const selected = meta(PANEL_A).channels.map(channelRef);
		const rows = projectionRows(selected, meta(PANEL_A).channels, index);
		assert.equal(rows.length, 3);
		assert.ok(rows.every((r) => r.on));
	});
});

describe('colorChoices', () => {
	const PANEL_B: MakeChannel[] = [
		{ name: 'FSC-A', bits: 32, range: 1024 },
		{ name: 'V450-A', label: 'cd8', bits: 32, range: 1024 },
	];

	it('offers density first, then the sample channels, keyed by $PnN', () => {
		const { current, available } = colorChoices(undefined, meta(PANEL_A).channels);
		// Density gets an entry above the divider too, so the divider is a
		// fixed part of the list rather than something that comes and goes.
		assert.deepEqual(current, { value: '', label: 'Density', ref: undefined });
		assert.deepEqual(available.map((c) => c.value), ['', 'FSC-A', 'R780-A', 'G710-A']);
		assert.deepEqual(available.map((c) => c.label), ['Density', 'FSC-A', 'cd3', 'cd4']);
		assert.equal(available[0]!.ref, undefined);
	});

	// The index-keyed version of this select showed cd8 when the card said cd3,
	// because both sit at index 1 in their own panel.
	it('keeps a colour channel the current sample does not have', () => {
		const cd3: ChannelRef = { name: 'R780-A', label: 'cd3', index: 1 };
		const { current, available } = colorChoices(cd3, meta(PANEL_B).channels);
		assert.equal(current.label, 'cd3 (not in this sample)');
		assert.deepEqual(current.ref, cd3);
		assert.deepEqual(available.map((c) => c.value), ['', 'FSC-A', 'V450-A']);
	});

	it('puts the current channel above the divider even when the sample has it', () => {
		const cd3: ChannelRef = { name: 'R780-A', label: 'cd3', index: 1 };
		const { current, available } = colorChoices(cd3, meta(PANEL_A).channels);
		assert.equal(current.label, 'cd3');
		assert.deepEqual(available.map((c) => c.value), ['', 'FSC-A', 'R780-A', 'G710-A']);
	});
});
