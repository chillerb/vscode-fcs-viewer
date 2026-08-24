import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { parseFcs, invertMatrix, compensateColumns, channelColumn } from '../../common/fcs';

// data/ is gitignored and ~40MB, so these never run in CI. Locally:
//   FCS_TEST_FILE=data/export_P01_US.863433.fcs \
//   FCS_TEST_FILE_2=data/001.fcs npm run test:unit
const CYTOF = process.env['FCS_TEST_FILE'];
const FLOW = process.env['FCS_TEST_FILE_2'];

function read(path: string): Uint8Array {
	return new Uint8Array(fs.readFileSync(path));
}

describe('real file: CyTOF (Helios)', { skip: !CYTOF }, () => {
	it('matches every known invariant', () => {
		const ds = parseFcs(read(CYTOF!));
		const m = ds.metadata;
		assert.equal(m.version, 'FCS3.0');
		assert.equal(m.delimiter, '/');
		assert.equal(m.mode, 'L');
		assert.equal(m.dataType, 'F');
		assert.equal(m.endianness, 'little');
		assert.equal(m.parameterCount, 56);
		assert.equal(m.declaredEventCount, 146215);
		assert.equal(ds.eventCount, 146215);
		assert.equal(ds.matrix.length, 146215 * 56);
		assert.equal(m.cytometer, 'DVSSCIENCES-CYTOF-1.3.0');
		assert.equal(m.cytometerSerial, 'Helios');
		assert.equal(m.nextData, 0);
		assert.equal(m.spillover, undefined, 'CyTOF files carry no spillover matrix');
		assert.ok(m.channels.every((c) => c.bits === 32));
	});

	it('keeps keywords aligned past the empty $FIL value', () => {
		const m = parseFcs(read(CYTOF!)).metadata;
		assert.equal(m.originalFile, '', '$FIL is empty in this file');
		assert.equal(m.beginTime, '20:05:53', 'if this shifted, TEXT parity broke at $FIL');
		assert.equal(m.channels[0]!.name, 'Time');
		assert.equal(m.channels[1]!.name, 'Event_length');
		assert.equal(m.channels[2]!.name, 'Pd102Di');
		assert.equal(m.channels[2]!.label, '102Pd_BC');
	});

	it('produces plausible per-channel values', () => {
		const ds = parseFcs(read(CYTOF!));
		const col = channelColumn(ds, 2);
		assert.equal(col.length, 146215);
		let min = Infinity;
		let max = -Infinity;
		for (const v of col) {
			if (v < min) { min = v; }
			if (v > max) { max = v; }
		}
		assert.ok(Number.isFinite(min) && Number.isFinite(max));
		assert.ok(max > min, 'the channel should not be constant');
		assert.ok(max <= 1e7, `implausible maximum ${max}; byte order is probably wrong`);
	});
});

describe('real file: BD LSRII', { skip: !FLOW }, () => {
	it('matches every known invariant', () => {
		const ds = parseFcs(read(FLOW!));
		const m = ds.metadata;
		assert.equal(m.version, 'FCS3.0');
		assert.equal(m.delimiter, '\\', 'this file uses a backslash delimiter');
		assert.equal(m.dataType, 'F');
		assert.equal(m.endianness, 'big', '$BYTEORD is 4,3,2,1');
		assert.equal(m.parameterCount, 22);
		assert.equal(ds.eventCount, 98657);
		assert.equal(ds.matrix.length, 98657 * 22);
		assert.equal(m.cytometer, 'LSRII');
		assert.equal(m.timestep, 0.01);
		assert.equal(m.channels[0]!.name, 'FSC-A');
		assert.equal(m.channels[10]!.name, 'R780-A');
		assert.equal(m.channels[10]!.label, 'cd3');
	});

	it('reads the bare SPILL keyword', () => {
		const m = parseFcs(read(FLOW!)).metadata;
		const sp = m.spillover;
		assert.ok(sp, 'SPILL should be found even without a leading $');
		assert.equal(sp.source, 'SPILL');
		assert.equal(sp.size, 13);
		assert.equal(sp.channels[0], 'B515-A');
		assert.equal(sp.channelIndices.length, 13);
		assert.ok(!sp.channelIndices.includes(0), 'FSC-A is outside the matrix');
	});

	it('compensates and inverts back to the observed values', () => {
		const ds = parseFcs(read(FLOW!));
		const sp = ds.metadata.spillover!;
		const inv = invertMatrix(sp.matrix, sp.size)!;
		const before = sp.channelIndices.map((i) => Float32Array.from(channelColumn(ds, i)));
		const comp = compensateColumns(ds.matrix, ds.eventCount, sp, inv);

		// Re-applying the spillover matrix must recover the observed values.
		for (let e = 0; e < 500; e++) {
			for (let j = 0; j < sp.size; j++) {
				let sum = 0;
				for (let i = 0; i < sp.size; i++) {
					sum += comp[i]![e]! * sp.matrix[i * sp.size + j]!;
				}
				const original = before[j]![e]!;
				const tol = Math.max(1, Math.abs(original) * 1e-4);
				assert.ok(Math.abs(sum - original) < tol, `event ${e} channel ${j}: ${sum} vs ${original}`);
			}
		}
	});

	it('leaves channels outside SPILL untouched', () => {
		const ds = parseFcs(read(FLOW!));
		const sp = ds.metadata.spillover!;
		const inv = invertMatrix(sp.matrix, sp.size)!;
		const fsc = Float32Array.from(channelColumn(ds, 0));
		const time = Float32Array.from(channelColumn(ds, 21));
		compensateColumns(ds.matrix, ds.eventCount, sp, inv);
		assert.deepEqual(Float32Array.from(channelColumn(ds, 0)), fsc);
		assert.deepEqual(Float32Array.from(channelColumn(ds, 21)), time);
	});
});
