/**
 * Builds spec-shaped FCS files in memory. data/ is gitignored and 40MB, so it
 * can never be the CI fixture; everything deterministic is generated here.
 */

export interface MakeChannel {
	name: string;
	label?: string;
	bits: number;
	range: number;
	/** $PnE as [decades, offset]. Defaults to [0, 0] (linear). */
	pnE?: [number, number];
	gain?: number;
}

export interface MakeFcsOptions {
	version?: string;
	delimiter?: string;
	channels: MakeChannel[];
	/** Row-major logical values: events[event][channel]. */
	events: number[][];
	dataType?: 'F' | 'D' | 'I';
	byteOrd?: string;
	mode?: string;
	extraKeywords?: Record<string, string>;
	/** Write 0 in the HEADER data fields and delegate to $BEGINDATA/$ENDDATA. */
	useDelegatedOffsets?: boolean;
	/** Write a $TOT that disagrees with the actual event count. */
	totOverride?: number;
	nextData?: number;
	spillover?: { keyword?: '$SPILLOVER' | '$SPILL' | 'SPILL'; channels: string[]; matrix: number[][] };
	/** Omit these keywords entirely, to exercise the missing-keyword paths. */
	omitKeywords?: string[];
	/**
	 * Shift the written DATA end offset, in bytes, away from the correct
	 * inclusive value. `+1` produces the exclusive-end convention that some
	 * writers emit (and that flowkit calls an offset error); `-1` produces the
	 * mirror bug that silently costs the last event. Applied to whichever of
	 * the HEADER field or $ENDDATA the file is using.
	 */
	dataEndDelta?: number;
	/**
	 * Bytes appended after DATA. Without these DATA ends the file, so an
	 * over-long end offset is clamped by the file length before the offset
	 * logic ever sees it -- which hides half the cases worth testing.
	 */
	trailingBytes?: number;
}

function pad8(n: number): string {
	const s = String(n);
	if (s.length > 8) {
		throw new Error(`offset ${n} does not fit in an 8-character HEADER field`);
	}
	return s.padStart(8, ' ');
}

function ascii(s: string): Uint8Array {
	const out = new Uint8Array(s.length);
	for (let i = 0; i < s.length; i++) {
		out[i] = s.charCodeAt(i) & 0xff;
	}
	return out;
}

function byteOrdIsBig(byteOrd: string): boolean {
	const parts = byteOrd.split(',').map(Number);
	return parts.length > 1 && parts[0]! > parts[parts.length - 1]!;
}

export function makeFcs(o: MakeFcsOptions): Uint8Array {
	const version = o.version ?? 'FCS3.0';
	const delim = o.delimiter ?? '/';
	const dataType = o.dataType ?? 'F';
	const byteOrd = o.byteOrd ?? '1,2,3,4';
	const nEvents = o.events.length;
	const nChan = o.channels.length;
	const omit = new Set(o.omitKeywords ?? []);

	const bitsPerEvent = o.channels.reduce((sum, c) => sum + c.bits, 0);
	if (bitsPerEvent % 8 !== 0) {
		throw new Error(`event size is ${bitsPerEvent} bits, which is not a whole number of bytes`);
	}
	const bytesPerEvent = bitsPerEvent / 8;
	const dataLength = nEvents * bytesPerEvent;

	const kw: Array<[string, string]> = [];
	const put = (k: string, v: string): void => {
		if (!omit.has(k)) {
			kw.push([k, v]);
		}
	};

	put('$BEGINANALYSIS', '0');
	put('$ENDANALYSIS', '0');
	put('$BEGINSTEXT', '0');
	put('$ENDSTEXT', '0');
	put('$NEXTDATA', String(o.nextData ?? 0));
	put('$MODE', o.mode ?? 'L');
	put('$DATATYPE', dataType);
	put('$BYTEORD', byteOrd);
	put('$PAR', String(nChan));
	put('$TOT', String(o.totOverride ?? nEvents));

	o.channels.forEach((c, idx) => {
		const n = idx + 1;
		put(`$P${n}N`, c.name);
		if (c.label !== undefined) {
			put(`$P${n}S`, c.label);
		}
		put(`$P${n}B`, String(c.bits));
		put(`$P${n}E`, `${c.pnE?.[0] ?? 0},${c.pnE?.[1] ?? 0}`);
		put(`$P${n}R`, String(c.range));
		if (c.gain !== undefined) {
			put(`$P${n}G`, String(c.gain));
		}
	});

	if (o.spillover) {
		const sp = o.spillover;
		const n = sp.channels.length;
		const flat = sp.matrix.flat().map(String).join(',');
		put(sp.keyword ?? '$SPILLOVER', `${n},${sp.channels.join(',')},${flat}`);
	}
	for (const [k, v] of Object.entries(o.extraKeywords ?? {})) {
		put(k, v);
	}

	// $BEGINDATA/$ENDDATA values are fixed-width so the TEXT length does not
	// change when they are filled in, letting the offsets resolve in one pass.
	const WIDTH = 12;
	const textBegin = 58;
	const fixedKw = [...kw];
	if (o.useDelegatedOffsets) {
		fixedKw.push(['$BEGINDATA', '0'.repeat(WIDTH)], ['$ENDDATA', '0'.repeat(WIDTH)]);
	}
	const render = (pairs: Array<[string, string]>): string =>
		delim + pairs.map(([k, v]) => `${k}${delim}${v}`).join(delim) + delim;

	let textStr = render(fixedKw);
	const textEnd = textBegin + textStr.length - 1;
	const dataBegin = textEnd + 1;
	// The correct, inclusive end -- then whatever the fixture asked us to
	// declare instead.
	const dataEnd = dataBegin + dataLength - 1 + (o.dataEndDelta ?? 0);

	if (o.useDelegatedOffsets) {
		const withOffsets = [...kw, ['$BEGINDATA', String(dataBegin).padStart(WIDTH, '0')] as [string, string], ['$ENDDATA', String(dataEnd).padStart(WIDTH, '0')] as [string, string]];
		textStr = render(withOffsets);
		if (textStr.length !== textEnd - textBegin + 1) {
			throw new Error('TEXT length changed after filling offsets; padding is wrong');
		}
	}

	const header =
		version.padEnd(10, ' ') +
		pad8(textBegin) +
		pad8(textEnd) +
		pad8(o.useDelegatedOffsets ? 0 : dataBegin) +
		pad8(o.useDelegatedOffsets ? 0 : dataEnd) +
		pad8(0) +
		pad8(0);

	const out = new Uint8Array(dataBegin + dataLength + (o.trailingBytes ?? 0));
	out.set(ascii(header), 0);
	out.set(ascii(textStr), textBegin);

	const view = new DataView(out.buffer);
	const big = byteOrdIsBig(byteOrd);
	const byteAligned = o.channels.every((c) => c.bits % 8 === 0);

	if (dataType === 'I' && !byteAligned) {
		// Bit-packed integers, MSB-first within the event. The reader has
		// always had readBits for this, and the README claims packed non-byte
		// widths are supported, but nothing could produce one to check.
		let bitCursor = dataBegin * 8;
		for (const event of o.events) {
			for (let c = 0; c < nChan; c++) {
				const bits = o.channels[c]!.bits;
				const v = event[c]!;
				for (let b = bits - 1; b >= 0; b--) {
					const bit = (v >>> b) & 1;
					if (bit) {
						const byte = bitCursor >> 3;
						out[byte] = out[byte]! | (0x80 >> (bitCursor & 7));
					}
					bitCursor++;
				}
			}
		}
		return out;
	}

	let off = dataBegin;
	for (const event of o.events) {
		for (let c = 0; c < nChan; c++) {
			const bits = o.channels[c]!.bits;
			const v = event[c]!;
			if (dataType === 'F') {
				view.setFloat32(off, v, !big);
			} else if (dataType === 'D') {
				view.setFloat64(off, v, !big);
			} else if (bits === 8) {
				view.setUint8(off, v);
			} else if (bits === 16) {
				view.setUint16(off, v, !big);
			} else if (bits === 32) {
				view.setUint32(off, v, !big);
			} else {
				throw new Error(`makeFcs cannot write ${bits}-bit integers`);
			}
			off += bits / 8;
		}
	}
	return out;
}

/** Convenience: n channels named P1..Pn with deterministic float values. */
export function simpleFloatFcs(nEvents: number, nChan: number, opts: Partial<MakeFcsOptions> = {}): Uint8Array {
	const channels: MakeChannel[] = [];
	for (let c = 0; c < nChan; c++) {
		channels.push({ name: `P${c + 1}`, bits: 32, range: 1024 });
	}
	const events: number[][] = [];
	for (let e = 0; e < nEvents; e++) {
		const row: number[] = [];
		for (let c = 0; c < nChan; c++) {
			row.push(e * 10 + c);
		}
		events.push(row);
	}
	return makeFcs({ channels, events, ...opts });
}
