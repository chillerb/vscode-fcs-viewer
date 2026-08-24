import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseTextSegment } from '../../common/fcs/text';
import { parseHeader } from '../../common/fcs/header';
import type { FcsWarning } from '../../common/fcs/errors';

function segment(text: string): { bytes: Uint8Array; end: number } {
	const bytes = new Uint8Array(text.length);
	for (let i = 0; i < text.length; i++) {
		bytes[i] = text.charCodeAt(i);
	}
	return { bytes, end: text.length - 1 };
}

function parse(text: string): { kw: Record<string, string>; warnings: FcsWarning[] } {
	const { bytes, end } = segment(text);
	const warnings: FcsWarning[] = [];
	const { keywords } = parseTextSegment(bytes, 0, end, warnings);
	return { kw: keywords, warnings };
}

describe('parseTextSegment', () => {
	it('parses simple key/value pairs', () => {
		const { kw } = parse('/$PAR/3/$TOT/100/');
		assert.deepEqual(kw, { $PAR: '3', $TOT: '100' });
	});

	it('uppercases keys but preserves values verbatim', () => {
		const { kw } = parse('/$date/ /$cyt/LSRII/');
		assert.equal(kw['$DATE'], ' ', 'a single-space value must survive');
		assert.equal(kw['$CYT'], 'LSRII');
	});

	it('handles a backslash delimiter', () => {
		const { kw } = parse('\\$PAR\\22\\$CYT\\LSRII\\');
		assert.deepEqual(kw, { $PAR: '22', $CYT: 'LSRII' });
	});

	it('handles a form-feed delimiter', () => {
		const { kw } = parse('\f$PAR\f7\f');
		assert.equal(kw['$PAR'], '7');
	});

	// The regression that motivates the whole module: this byte sequence is
	// taken from data/export_P01_US.863433.fcs at offset 0x94.
	it('reads $FIL// as an empty value, keeping later keywords aligned', () => {
		const { kw, warnings } = parse('/$DATE/ /$FIL//$BTIM/20:05:53/$ETIM/ /$MODE/L/');
		assert.equal(kw['$FIL'], '', '$FIL should be empty');
		assert.equal(kw['$BTIM'], '20:05:53', '$BTIM must not absorb the next token');
		assert.equal(kw['$ETIM'], ' ');
		assert.equal(kw['$MODE'], 'L', 'parity must survive to the end of the segment');
		assert.ok(
			warnings.some((w) => w.code === 'EMPTY_VALUE_AMBIGUITY' && w.keyword === '$FIL'),
			'the ambiguity should be reported',
		);
	});

	it('treats a doubled delimiter inside a value as an escape', () => {
		const { kw } = parse('/$FIL/a//b/$TOT/5/');
		assert.equal(kw['$FIL'], 'a/b');
		assert.equal(kw['$TOT'], '5');
	});

	it('handles a value that begins with an escaped delimiter', () => {
		// Ambiguous at the byte level: the first pair splits the key, the second
		// is then seen at value parity and read as an escape.
		const { kw } = parse('/$FIL///data.fcs/$TOT/5/');
		assert.equal(kw['$FIL'], '/data.fcs');
		assert.equal(kw['$TOT'], '5');
	});

	it('handles an empty value at the very end of the segment', () => {
		const { kw } = parse('/$TOT/5/$FIL//');
		assert.equal(kw['$TOT'], '5');
		assert.equal(kw['$FIL'], '');
	});

	it('warns and drops a dangling token', () => {
		const { kw, warnings } = parse('/$PAR/3/$TOT/');
		assert.equal(kw['$PAR'], '3');
		assert.ok(!('$TOT' in kw));
		assert.ok(warnings.some((w) => w.code === 'ODD_TOKEN_COUNT'));
	});

	it('tolerates a missing trailing delimiter', () => {
		const { kw } = parse('/$PAR/3');
		assert.equal(kw['$PAR'], '3');
	});

	it('warns on an alphanumeric delimiter', () => {
		const { warnings } = parse('X$PARX3X');
		assert.ok(warnings.some((w) => w.code === 'ODD_DELIMITER'));
	});

	it('clamps and warns when the segment runs past the end of the file', () => {
		const { bytes } = segment('/$PAR/3/');
		const warnings: FcsWarning[] = [];
		const { keywords } = parseTextSegment(bytes, 0, 9999, warnings);
		assert.equal(keywords['$PAR'], '3');
		assert.ok(warnings.some((w) => w.code === 'TEXT_TRUNCATED'));
	});

	it('preserves latin-1 vendor bytes rather than replacing them', () => {
		const bytes = new Uint8Array([0x2f, 0x4b, 0x2f, 0xb5, 0x6d, 0x2f]); // /K/<0xB5>m/
		const warnings: FcsWarning[] = [];
		const { keywords } = parseTextSegment(bytes, 0, bytes.length - 1, warnings);
		assert.equal(keywords['K'], 'µm');
	});
});

describe('parseHeader', () => {
	it('parses right-justified space-padded offsets', () => {
		const text = 'FCS3.0          58    3522    352332755682       0       0';
		const bytes = new Uint8Array(58);
		for (let i = 0; i < 58; i++) {
			bytes[i] = text.charCodeAt(i);
		}
		const warnings: FcsWarning[] = [];
		const h = parseHeader(bytes, warnings);
		assert.equal(h.version, 'FCS3.0');
		assert.deepEqual(h.text, { begin: 58, end: 3522 });
		assert.deepEqual(h.data, { begin: 3523, end: 32755682 });
		assert.deepEqual(h.analysis, { begin: 0, end: 0 });
		assert.equal(warnings.length, 0);
	});

	it('rejects a file shorter than the header', () => {
		assert.throws(() => parseHeader(new Uint8Array(20), []), /FCS HEADER needs at least/);
	});

	it('rejects a header with no TEXT segment', () => {
		const bytes = new Uint8Array(58).fill(0x20);
		bytes.set([0x46, 0x43, 0x53, 0x33, 0x2e, 0x30], 0);
		assert.throws(() => parseHeader(bytes, []), /does not declare a TEXT segment/);
	});

	it('warns on an unknown version but keeps going', () => {
		const text = 'FCS9.9          58    3522       0       0       0       0';
		const bytes = new Uint8Array(58);
		for (let i = 0; i < 58; i++) {
			bytes[i] = text.charCodeAt(i);
		}
		const warnings: FcsWarning[] = [];
		parseHeader(bytes, warnings);
		assert.ok(warnings.some((w) => w.code === 'UNKNOWN_VERSION'));
	});
});
