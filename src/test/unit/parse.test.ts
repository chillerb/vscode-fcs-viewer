import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseFcs, FcsParseError } from '../../common/fcs';
import { makeFcs, simpleFloatFcs, type MakeChannel } from './fixtures/makeFcs';

const CH: MakeChannel[] = [
	{ name: 'FSC-A', bits: 32, range: 1024 },
	{ name: 'B515-A', label: 'cd3', bits: 32, range: 1024 },
	{ name: 'Time', bits: 32, range: 1024 },
];

const EVENTS = [
	[1, 10, 100],
	[2, 20, 200],
	[3, 30, 300],
	[4, 40, 400],
	[5, 50, 500],
];

describe('parseFcs', () => {
	it('round-trips float data into a column-major matrix', () => {
		const ds = parseFcs(makeFcs({ channels: CH, events: EVENTS }));
		assert.equal(ds.eventCount, 5);
		assert.equal(ds.channelCount, 3);
		assert.equal(ds.matrix.length, 15);
		// The layout contract, asserted explicitly: matrix[c * eventCount + e].
		assert.equal(ds.matrix[1 * 5 + 3], 40);
		assert.equal(ds.matrix[2 * 5 + 0], 100);
		for (let e = 0; e < 5; e++) {
			for (let c = 0; c < 3; c++) {
				assert.equal(ds.matrix[c * 5 + e], EVENTS[e]![c]);
			}
		}
	});

	it('exposes $PnN, $PnS and a display name', () => {
		const ds = parseFcs(makeFcs({ channels: CH, events: EVENTS }));
		assert.equal(ds.metadata.channels[1]!.name, 'B515-A');
		assert.equal(ds.metadata.channels[1]!.label, 'cd3');
		assert.equal(ds.metadata.channels[1]!.displayName, 'cd3');
		assert.equal(ds.metadata.channels[0]!.displayName, 'FSC-A');
	});

	it('classifies scatter, time and marker channels', () => {
		const ds = parseFcs(makeFcs({ channels: CH, events: EVENTS }));
		assert.equal(ds.metadata.channels[0]!.kind, 'scatter');
		assert.equal(ds.metadata.channels[1]!.kind, 'marker');
		assert.equal(ds.metadata.channels[2]!.kind, 'time');
	});

	it('reads big-endian float data', () => {
		const ds = parseFcs(makeFcs({ channels: CH, events: EVENTS, byteOrd: '4,3,2,1' }));
		assert.equal(ds.metadata.endianness, 'big');
		assert.equal(ds.matrix[1 * 5 + 3], 40);
	});

	it('normalises a zero-based $BYTEORD', () => {
		const ds = parseFcs(makeFcs({ channels: CH, events: EVENTS, byteOrd: '0,1,2,3' }));
		assert.equal(ds.metadata.endianness, 'little');
		assert.ok(ds.metadata.warnings.some((w) => w.code === 'BYTEORD_ZERO_BASED'));
		assert.equal(ds.matrix[1 * 5 + 3], 40);
	});

	it('reads 64-bit double data', () => {
		const channels = CH.map((c) => ({ ...c, bits: 64 }));
		const ds = parseFcs(makeFcs({ channels, events: EVENTS, dataType: 'D' }));
		assert.equal(ds.matrix[2 * 5 + 4], 500);
	});

	it('reads 8-, 16- and 32-bit integer data', () => {
		for (const bits of [8, 16, 32]) {
			const channels = CH.map((c) => ({ ...c, bits, range: 256 }));
			const events = [[1, 2, 3], [4, 5, 6]];
			const ds = parseFcs(makeFcs({ channels, events, dataType: 'I' }));
			assert.equal(ds.matrix[1 * 2 + 1], 5, `${bits}-bit`);
		}
	});

	it('honours delegated $BEGINDATA/$ENDDATA offsets', () => {
		const ds = parseFcs(makeFcs({ channels: CH, events: EVENTS, useDelegatedOffsets: true }));
		assert.equal(ds.eventCount, 5);
		assert.equal(ds.matrix[1 * 5 + 3], 40);
	});

	it('takes the smaller count and warns when $TOT disagrees with the segment', () => {
		const ds = parseFcs(makeFcs({ channels: CH, events: EVENTS, totOverride: 99 }));
		assert.equal(ds.eventCount, 5);
		assert.ok(ds.metadata.warnings.some((w) => w.code === 'EVENT_COUNT_MISMATCH'));
	});

	it('warns but still parses when $NEXTDATA is non-zero', () => {
		const ds = parseFcs(makeFcs({ channels: CH, events: EVENTS, nextData: 4096 }));
		assert.equal(ds.eventCount, 5);
		assert.ok(ds.metadata.warnings.some((w) => w.code === 'MULTIPLE_DATASETS'));
	});

	it('decodes $PnE log amplification on integer data', () => {
		const channels: MakeChannel[] = [{ name: 'L', bits: 16, range: 1024, pnE: [4, 0.01] }];
		const events = [[0], [512], [1024]];
		const ds = parseFcs(makeFcs({ channels, events, dataType: 'I' }));
		assert.equal(ds.matrix[0], 0, 'zero is the conventional special case');
		assert.ok(Math.abs(ds.matrix[1]! - 0.01 * Math.pow(10, (4 * 512) / 1024)) < 1e-3);
	});

	it('repairs a zero $PnE offset', () => {
		const channels: MakeChannel[] = [{ name: 'L', bits: 16, range: 1024, pnE: [4, 0] }];
		const ds = parseFcs(makeFcs({ channels, events: [[512]], dataType: 'I' }));
		assert.ok(ds.metadata.warnings.some((w) => w.code === 'PNE_ZERO_OFFSET'));
		assert.ok(Math.abs(ds.matrix[0]! - Math.pow(10, 2)) < 1e-6);
	});

	it('forces log $PnE on float data back to linear', () => {
		const channels: MakeChannel[] = [{ name: 'L', bits: 32, range: 1024, pnE: [4, 1] }];
		const ds = parseFcs(makeFcs({ channels, events: [[42]] }));
		assert.ok(ds.metadata.warnings.some((w) => w.code === 'PNE_ON_FLOAT'));
		assert.equal(ds.matrix[0], 42);
	});

	it('applies $PnG gain', () => {
		const channels: MakeChannel[] = [{ name: 'G', bits: 32, range: 1024, gain: 2 }];
		const ds = parseFcs(makeFcs({ channels, events: [[10]] }));
		assert.equal(ds.matrix[0], 5);
	});

	it('rejects $MODE C', () => {
		assert.throws(
			() => parseFcs(makeFcs({ channels: CH, events: EVENTS, mode: 'C' })),
			(e: unknown) => e instanceof FcsParseError && e.code === 'FCS_UNSUPPORTED_MODE',
		);
	});

	it('rejects $DATATYPE A with an actionable message', () => {
		const bytes = makeFcs({ channels: CH, events: EVENTS });
		const patched = new TextDecoder('latin1').decode(bytes).replace('$DATATYPE/F', '$DATATYPE/A');
		const out = new Uint8Array(patched.length);
		for (let i = 0; i < patched.length; i++) {
			out[i] = patched.charCodeAt(i);
		}
		assert.throws(
			() => parseFcs(out),
			(e: unknown) => e instanceof FcsParseError && e.code === 'FCS_UNSUPPORTED_DATATYPE' && /Re-export/.test(e.message),
		);
	});

	it('reports the name of a missing required keyword', () => {
		assert.throws(
			() => parseFcs(makeFcs({ channels: CH, events: EVENTS, omitKeywords: ['$PAR'] })),
			(e: unknown) => e instanceof FcsParseError && e.code === 'FCS_MISSING_KEYWORD' && e.detail.keyword === '$PAR',
		);
	});

	it('parses a zero-event file without throwing', () => {
		const ds = parseFcs(makeFcs({ channels: CH, events: [] }));
		assert.equal(ds.eventCount, 0);
		assert.equal(ds.matrix.length, 0);
	});

	it('parses a 56 x 20,000 file in well under half a second', () => {
		const bytes = simpleFloatFcs(20_000, 56);
		const started = process.hrtime.bigint();
		const ds = parseFcs(bytes);
		const ms = Number(process.hrtime.bigint() - started) / 1e6;
		assert.equal(ds.matrix.length, 20_000 * 56);
		assert.ok(ms < 500, `parse took ${ms.toFixed(0)}ms; a DataView-per-value regression is likely`);
	});
});
