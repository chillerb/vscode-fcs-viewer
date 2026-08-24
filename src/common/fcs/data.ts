import { FcsParseError, warn, type FcsWarning } from './errors';
import { parseByteOrd } from './byteOrder';
import type { CancellationLike, FcsMetadata } from './types';

export interface DataParseResult {
	/** Column-major: matrix[c * eventCount + e]. */
	matrix: Float32Array;
	eventCount: number;
}

export interface DataParseOptions {
	applyScaling: boolean;
	maxValues: number;
	signal?: CancellationLike;
}

/** Cancellation check, cheap enough to call once per channel pass. */
function throwIfCancelled(options: { signal?: CancellationLike }): void {
	if (options.signal?.isCancellationRequested) {
		throw new FcsParseError('FCS_CANCELLED', 'Parsing was cancelled.');
	}
}

/** Reads `bits` bits at an arbitrary bit offset, MSB-first within the event. */
function readBits(bytes: Uint8Array, base: number, bitOffset: number, bits: number): number {
	let value = 0;
	for (let b = 0; b < bits; b++) {
		const bit = bitOffset + b;
		const byte = bytes[base + (bit >> 3)]!;
		value = value * 2 + ((byte >> (7 - (bit & 7))) & 1);
	}
	return value;
}

/** Number of low bits needed to represent values up to $PnR - 1. */
function maskBits(range: number, bits: number): number {
	if (!(range > 1)) {
		return bits;
	}
	const needed = Math.ceil(Math.log2(range));
	return Math.min(needed, bits);
}

export function parseDataSegment(
	bytes: Uint8Array,
	meta: FcsMetadata,
	options: DataParseOptions,
	warnings: FcsWarning[],
): DataParseResult {
	const { channels, dataType } = meta;
	const channelCount = channels.length;
	const { begin, end } = meta.header.data;

	const bitsPerEvent = channels.reduce((sum, c) => sum + c.bits, 0);
	if (bitsPerEvent % 8 !== 0) {
		throw new FcsParseError('FCS_UNSUPPORTED_BITWIDTH', `Event size is ${bitsPerEvent} bits, which is not a whole number of bytes.`, {
			hint: 'FCS requires byte-aligned events even when individual $PnB are not multiples of 8.',
		});
	}
	const bytesPerEvent = bitsPerEvent / 8;
	if (bytesPerEvent === 0) {
		throw new FcsParseError('FCS_BAD_TEXT', 'All channels declare a width of zero bits.');
	}

	/*
	 * Repair a declared end that is off by less than one event.
	 *
	 * The spec's end offset is inclusive, but a well-known family of writers
	 * emits it exclusively -- one byte too many. (Python's flowkit exposes the
	 * same situation as `ignore_offset_error`.) The mirror-image bug, an end
	 * one byte short, also exists in the wild and is worse: the shortfall
	 * silently costs the last event.
	 *
	 * Both are handled by one rule. $TOT and the channel widths together say
	 * exactly where the data must end, so when the declared end disagrees by
	 * less than a whole event it is the declaration that is wrong, not the
	 * data. The repair is bounded twice -- by $TOT and by the physical file
	 * length -- so it can never invent events or read past the end.
	 */
	let effectiveEnd = end;
	const impliedEnd = begin + meta.declaredEventCount * bytesPerEvent - 1;
	if (
		meta.declaredEventCount > 0 &&
		impliedEnd !== end &&
		Math.abs(impliedEnd - end) < bytesPerEvent &&
		impliedEnd <= bytes.length - 1
	) {
		warn(
			warnings,
			'OFFSET_OFF_BY_LESS_THAN_AN_EVENT',
			`DATA is declared to end at byte ${end}, but $TOT and the channel widths put the last byte at ${impliedEnd}` +
			` (a difference of ${Math.abs(impliedEnd - end)} of ${bytesPerEvent} bytes per event).` +
			` This is a known writer bug -- usually an end offset written exclusively rather than inclusively -- so the file is read in full.`,
			'$ENDDATA',
		);
		effectiveEnd = impliedEnd;
	}

	const segmentEnd = Math.min(effectiveEnd, bytes.length - 1);
	if (segmentEnd < effectiveEnd) {
		warn(warnings, 'EVENT_COUNT_MISMATCH', `DATA segment claims to end at byte ${effectiveEnd} but the file is ${bytes.length} bytes; reading what is there.`);
	}
	const segmentBytes = segmentEnd - begin + 1;
	if (segmentBytes % bytesPerEvent !== 0) {
		warn(
			warnings,
			'OFFSET_MISALIGNED',
			`The DATA segment spans ${segmentBytes} bytes, which is not a whole number of ${bytesPerEvent}-byte events;` +
			` the trailing ${segmentBytes % bytesPerEvent} bytes are ignored.`,
		);
	}
	const available = Math.floor(segmentBytes / bytesPerEvent);
	let eventCount = meta.declaredEventCount;
	if (available !== eventCount) {
		warn(
			warnings,
			'EVENT_COUNT_MISMATCH',
			`$TOT declares ${meta.declaredEventCount} events but the DATA segment holds ${available}; using ${Math.min(available, eventCount)}.`,
			'$TOT',
		);
		eventCount = Math.min(available, eventCount);
	}
	if (eventCount < 0) {
		eventCount = 0;
	}

	const total = eventCount * channelCount;
	if (total > options.maxValues) {
		// Deliberately does NOT name fcsViewer.maxFileSizeMB: that setting is
		// checked separately against the file's byte size before parsing
		// starts, and raising it has no effect on this ceiling. The limit here
		// is on values, because the decoded matrix is 4 bytes each regardless
		// of how compactly the file stored them.
		throw new FcsParseError('FCS_TOO_LARGE', `This file holds ${total.toLocaleString()} values, above the ${options.maxValues.toLocaleString()} the viewer will decode.`, {
			hint: `${eventCount.toLocaleString()} events x ${channelCount} channels would need `
				+ `${((total * 4) / 1073741824).toFixed(1)} GB of memory once decoded.`,
		});
	}

	const matrix = new Float32Array(total);
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const { endianness, permutation } = parseByteOrd(meta.byteOrd, []);
	const little = endianness !== 'big';

	// Per-channel byte offset within an event, and per-channel scaling, both
	// hoisted out of the hot loop.
	const offsets = new Int32Array(channelCount);
	const bitOffsets = new Int32Array(channelCount);
	let cursorBits = 0;
	for (let c = 0; c < channelCount; c++) {
		bitOffsets[c] = cursorBits;
		offsets[c] = cursorBits >> 3;
		cursorBits += channels[c]!.bits;
	}
	const byteAligned = channels.every((c) => c.bits % 8 === 0);

	const nonFinite = new Int32Array(channelCount);

	// Fast path: float32, little-endian, byte-aligned and 4-byte aligned in the
	// backing buffer. Avoids ~8M DataView calls on the 31MB fixture.
	const absoluteBegin = bytes.byteOffset + begin;
	const canUseTypedView =
		dataType === 'F' &&
		little &&
		permutation === null &&
		byteAligned &&
		absoluteBegin % 4 === 0 &&
		channels.every((c) => c.bits === 32);

	if (canUseTypedView) {
		const src = new Float32Array(bytes.buffer, absoluteBegin, eventCount * channelCount);
		for (let c = 0; c < channelCount; c++) {
			// The fast path is the one the 31 MB CyTOF file takes, so polling
			// only in the slow branch made Cancel do nothing on exactly the
			// files slow enough for anyone to press it.
			throwIfCancelled(options);
			const col = c * eventCount;
			for (let e = 0; e < eventCount; e++) {
				matrix[col + e] = src[e * channelCount + c]!;
			}
		}
	} else {
		for (let e = 0; e < eventCount; e++) {
			if ((e & 8191) === 0) {
				throwIfCancelled(options);
			}
			const base = begin + e * bytesPerEvent;
			for (let c = 0; c < channelCount; c++) {
				const ch = channels[c]!;
				const at = base + offsets[c]!;
				let v: number;
				if (dataType === 'F') {
					v = permutation ? permuteFloat(bytes, at, permutation, 4) : view.getFloat32(at, little);
				} else if (dataType === 'D') {
					v = permutation ? permuteFloat(bytes, at, permutation, 8) : view.getFloat64(at, little);
				} else if (byteAligned) {
					switch (ch.bits) {
						case 8: v = view.getUint8(at); break;
						case 16: v = view.getUint16(at, little); break;
						case 32: v = view.getUint32(at, little); break;
						case 64: v = Number(view.getBigUint64(at, little)); break;
						default: throw new FcsParseError('FCS_UNSUPPORTED_BITWIDTH', `Unsupported integer width $P${ch.n}B = ${ch.bits}.`);
					}
					const mb = maskBits(ch.range, ch.bits);
					if (mb < ch.bits && mb < 32) {
						v = v & ((1 << mb) - 1);
					}
				} else {
					v = readBits(bytes, base, bitOffsets[c]!, ch.bits);
					const mb = maskBits(ch.range, ch.bits);
					if (mb < ch.bits && mb < 32) {
						v = v & ((1 << mb) - 1);
					}
				}
				matrix[c * eventCount + e] = v;
			}
		}
	}

	if (options.applyScaling) {
		for (let c = 0; c < channelCount; c++) {
			throwIfCancelled(options);
			const ch = channels[c]!;
			const col = c * eventCount;
			if (ch.amplification === 'log' && ch.range > 0) {
				const decades = ch.logDecades;
				const offset = ch.logOffset;
				const range = ch.range;
				for (let e = 0; e < eventCount; e++) {
					const raw = matrix[col + e]!;
					matrix[col + e] = raw === 0 ? 0 : offset * Math.pow(10, (decades * raw) / range);
				}
			} else if (ch.gain !== undefined && ch.gain !== 1) {
				const gain = ch.gain;
				for (let e = 0; e < eventCount; e++) {
					matrix[col + e] = matrix[col + e]! / gain;
				}
			}
		}
	}

	for (let c = 0; c < channelCount; c++) {
		throwIfCancelled(options);
		const col = c * eventCount;
		let bad = 0;
		for (let e = 0; e < eventCount; e++) {
			if (!Number.isFinite(matrix[col + e]!)) {
				bad++;
			}
		}
		nonFinite[c] = bad;
		if (bad > 0) {
			warn(warnings, 'NON_FINITE_VALUES', `Channel "${channels[c]!.name}" has ${bad} non-finite values; they are excluded from plots and statistics.`);
		}
	}

	return { matrix, eventCount };
}

/** Reassemble a float whose bytes are stored in a non-standard order. */
function permuteFloat(bytes: Uint8Array, at: number, permutation: number[], width: number): number {
	const tmp = new Uint8Array(width);
	for (let i = 0; i < width && i < permutation.length; i++) {
		tmp[permutation[i]!] = bytes[at + i]!;
	}
	const dv = new DataView(tmp.buffer);
	return width === 4 ? dv.getFloat32(0, true) : dv.getFloat64(0, true);
}
