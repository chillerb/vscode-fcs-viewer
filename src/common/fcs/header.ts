import { FcsParseError, warn, type FcsWarning } from './errors';
import type { FcsHeader, FcsSegmentOffsets } from './types';

export const HEADER_LENGTH = 58;

const KNOWN_VERSIONS = new Set(['FCS2.0', 'FCS3.0', 'FCS3.1', 'FCS3.2']);

/** Decode ASCII/latin-1 without ever producing U+FFFD for vendor bytes. */
export function decodeLatin1(bytes: Uint8Array, begin: number, end: number): string {
	let out = '';
	// Chunked to stay well under the argument limit of String.fromCharCode.
	const CHUNK = 4096;
	for (let i = begin; i < end; i += CHUNK) {
		const slice = bytes.subarray(i, Math.min(i + CHUNK, end));
		out += String.fromCharCode(...slice);
	}
	return out;
}

/**
 * Parse one of the six 8-character, right-justified, space-padded offset fields.
 * All-spaces means "absent", which the spec encodes as 0.
 */
function parseOffsetField(bytes: Uint8Array, offset: number): number {
	const raw = decodeLatin1(bytes, offset, offset + 8).trim();
	if (raw === '') {
		return 0;
	}
	if (!/^\d+$/.test(raw)) {
		throw new FcsParseError('FCS_BAD_HEADER', `Malformed HEADER offset field "${raw}" at byte ${offset}.`, {
			offset,
			hint: 'The first 58 bytes do not look like an FCS HEADER.',
		});
	}
	return Number(raw);
}

export function parseHeader(bytes: Uint8Array, warnings: FcsWarning[]): FcsHeader {
	if (bytes.length < HEADER_LENGTH) {
		throw new FcsParseError('FCS_TRUNCATED', `File is ${bytes.length} bytes; an FCS HEADER needs at least ${HEADER_LENGTH}.`, {
			hint: 'The file is truncated or is not an FCS file.',
		});
	}

	const version = decodeLatin1(bytes, 0, 6);
	if (!KNOWN_VERSIONS.has(version)) {
		warn(warnings, 'UNKNOWN_VERSION', `Unrecognised FCS version "${version}"; parsing optimistically as FCS3.0.`);
	}

	const seg = (begin: number): FcsSegmentOffsets => ({
		begin: parseOffsetField(bytes, begin),
		end: parseOffsetField(bytes, begin + 8),
	});

	const text = seg(10);
	const data = seg(26);
	const analysis = seg(42);

	// TEXT offsets may never be delegated to keywords -- they are how you find
	// the keywords in the first place.
	if (text.begin === 0 || text.end === 0) {
		throw new FcsParseError('FCS_BAD_HEADER', 'HEADER does not declare a TEXT segment.', {
			hint: 'The file is corrupt or is not an FCS file.',
		});
	}
	if (text.end < text.begin) {
		throw new FcsParseError('FCS_BAD_HEADER', `TEXT segment ends (${text.end}) before it begins (${text.begin}).`);
	}

	return { version, text, data, analysis };
}
