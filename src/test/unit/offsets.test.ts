import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseFcs } from '../../common/fcs';
import { makeFcs, type MakeFcsOptions } from './fixtures/makeFcs';

/**
 * DATA segment offset handling.
 *
 * FCS declares the end offset inclusively, and real writers get this wrong in
 * both directions. Until now the only offset coverage in the tree was the
 * happy-path delegated case, and the real-file assertions that would have
 * caught the rest are gated behind gitignored 40 MB files. These are a few KB
 * and run in CI.
 */

const CHANNELS = [
	{ name: 'FSC-A', bits: 32, range: 1024 },
	{ name: 'B515-A', label: 'cd3', bits: 32, range: 1024 },
];
const EVENTS = [[1, 2], [3, 4], [5, 6], [7, 8]];

function parse(opts: Partial<MakeFcsOptions> = {}): ReturnType<typeof parseFcs> {
	return parseFcs(makeFcs({ channels: CHANNELS, events: EVENTS, ...opts }));
}

function codes(ds: ReturnType<typeof parseFcs>): string[] {
	return ds.metadata.warnings.map((w) => w.code);
}

describe('DATA offsets declared one byte too long (the exclusive-end convention)', () => {
	// Python's flowkit calls this an offset error and requires an opt-in flag
	// to read the file at all. We repair it instead: $TOT and the channel
	// widths say exactly where the data ends, so nothing is being guessed.
	it('reads every event when DATA is the last thing in the file', () => {
		const ds = parse({ dataEndDelta: 1 });
		assert.equal(ds.eventCount, EVENTS.length);
		assert.deepEqual([...ds.matrix.subarray(0, 4)], [1, 3, 5, 7]);
	});

	it('reads every event when bytes follow DATA', () => {
		const ds = parse({ dataEndDelta: 1, trailingBytes: 64 });
		assert.equal(ds.eventCount, EVENTS.length);
		assert.deepEqual([...ds.matrix.subarray(4, 8)], [2, 4, 6, 8]);
	});

	it('names the real cause rather than blaming the event count', () => {
		const ds = parse({ dataEndDelta: 1 });
		assert.ok(
			codes(ds).includes('OFFSET_OFF_BY_LESS_THAN_AN_EVENT'),
			`expected an offset warning, got ${codes(ds).join(', ') || 'none'}`,
		);
		// The old behaviour was to report this as a truncated file, which made
		// a perfectly readable file look corrupt.
		assert.ok(!codes(ds).includes('EVENT_COUNT_MISMATCH'));
	});

	it('repairs the delegated $ENDDATA form too', () => {
		const ds = parse({ dataEndDelta: 1, useDelegatedOffsets: true });
		assert.equal(ds.eventCount, EVENTS.length);
	});
});

describe('DATA offsets declared one byte too short', () => {
	// The mirror-image bug, and the more dangerous one: the shortfall used to
	// be absorbed by Math.min and cost the last event with no clear warning.
	it('still recovers the final event', () => {
		const ds = parse({ dataEndDelta: -1 });
		assert.equal(ds.eventCount, EVENTS.length, 'the last event must not be dropped');
		assert.deepEqual([...ds.matrix.subarray(0, 4)], [1, 3, 5, 7]);
		assert.ok(codes(ds).includes('OFFSET_OFF_BY_LESS_THAN_AN_EVENT'));
	});
});

describe('DATA offsets that are wrong by more than one event', () => {
	it('does not silently invent events when the end is far too long', () => {
		// Beyond one event, the discrepancy is not a rounding convention and
		// the file length is the only trustworthy bound.
		const ds = parse({ dataEndDelta: 40 });
		assert.equal(ds.eventCount, EVENTS.length);
		assert.ok(codes(ds).includes('EVENT_COUNT_MISMATCH'));
		assert.ok(!codes(ds).includes('OFFSET_OFF_BY_LESS_THAN_AN_EVENT'));
	});

	it('reports a segment that is not a whole number of events', () => {
		const ds = parse({ dataEndDelta: 10, trailingBytes: 64 });
		assert.ok(
			codes(ds).includes('OFFSET_MISALIGNED'),
			`expected a misalignment warning, got ${codes(ds).join(', ')}`,
		);
	});

	it('clamps to the file when DATA genuinely runs past the end', () => {
		const ds = parse({ dataEndDelta: 400 });
		assert.ok(ds.eventCount <= EVENTS.length);
		assert.ok(codes(ds).includes('EVENT_COUNT_MISMATCH'));
		// The real guarantee: no read past the buffer.
		assert.equal(ds.matrix.length, ds.eventCount * CHANNELS.length);
	});
});

describe('$ENDDATA disagreeing with the HEADER', () => {
	it('warns and trusts the keyword', () => {
		// The HEADER end is correct here and $ENDDATA is not; only the begin
		// offsets used to be compared, so this went through in silence.
		const correctEnd = 58;
		const ds = parseFcs(makeFcs({
			channels: CHANNELS,
			events: EVENTS,
			extraKeywords: { $ENDDATA: String(correctEnd + 100000) },
		}));
		assert.ok(
			codes(ds).includes('OFFSET_MISMATCH'),
			`expected an offset mismatch, got ${codes(ds).join(', ') || 'none'}`,
		);
	});
});

describe('spillover keyword variants end to end', () => {
	const SP_CHANNELS = [
		{ name: 'FSC-A', bits: 32, range: 1024 },
		{ name: 'FITC-A', label: 'cd3', bits: 32, range: 1024 },
		{ name: 'PE-A', label: 'cd4', bits: 32, range: 1024 },
	];

	for (const keyword of ['$SPILLOVER', '$SPILL', 'SPILL'] as const) {
		it(`parses a matrix declared as ${keyword}, covering only some channels`, () => {
			const ds = parseFcs(makeFcs({
				channels: SP_CHANNELS,
				events: [[100, 200, 300], [400, 500, 600]],
				// FSC-A is deliberately absent from the matrix: real files
				// compensate fluorescence detectors only.
				spillover: { keyword, channels: ['FITC-A', 'PE-A'], matrix: [[1, 0.1], [0.05, 1]] },
			}));
			const sp = ds.metadata.spillover;
			assert.ok(sp, `${keyword} should yield a spillover matrix`);
			assert.equal(sp.source, keyword);
			assert.equal(sp.size, 2);
			assert.deepEqual(sp.channels, ['FITC-A', 'PE-A']);
			// Resolved to real matrix columns, and FSC-A is left out -- which
			// is what lets compensation touch only the detectors it covers.
			assert.deepEqual(sp.channelIndices, [1, 2]);
		});
	}
});

describe('bit-packed integer channels', () => {
	// $PnB need not be a multiple of 8 as long as the event is. The reader has
	// always had readBits for this and the README claims support, but the
	// fixture builder could not emit one until now, so it was never checked.
	it('decodes 12 + 12 + 8 bit channels', () => {
		const channels = [
			{ name: 'A', bits: 12, range: 4096 },
			{ name: 'B', bits: 12, range: 4096 },
			{ name: 'C', bits: 8, range: 256 },
		];
		const events = [[0, 4095, 255], [1, 2, 3], [4095, 0, 128]];
		const ds = parseFcs(makeFcs({ channels, events, dataType: 'I', byteOrd: '1,2,3,4' }));

		assert.equal(ds.eventCount, events.length);
		for (let c = 0; c < channels.length; c++) {
			const col = [...ds.matrix.subarray(c * events.length, (c + 1) * events.length)];
			assert.deepEqual(col, events.map((e) => e[c]), `channel ${channels[c]!.name}`);
		}
	});
});

describe('an empty $FIL written as a doubled delimiter', () => {
	// The invariant the whole delimiter algorithm exists to protect, and until
	// now only asserted against a gitignored real file.
	it('keeps every later keyword aligned', () => {
		const ds = parseFcs(makeFcs({
			channels: CHANNELS,
			events: EVENTS,
			extraKeywords: { $FIL: '', $BTIM: '20:05:53', $CYT: 'LSRII' },
		}));
		assert.equal(ds.metadata.cytometer, 'LSRII');
		assert.equal(ds.metadata.keywords['$BTIM'], '20:05:53');
		assert.equal(ds.metadata.keywords['$FIL'], '');
		// Alignment is the point: a mis-parse shifts values onto the wrong
		// keys and the channels come out wrong rather than merely missing.
		assert.equal(ds.channelCount, CHANNELS.length);
		assert.equal(ds.metadata.channels[1]!.label, 'cd3');
	});
});
