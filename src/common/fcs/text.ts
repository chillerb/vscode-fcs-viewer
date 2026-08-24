import { FcsParseError, warn, type FcsWarning } from './errors';
import { decodeLatin1 } from './header';

export interface TextSegment {
	keywords: Record<string, string>;
	delimiter: string;
}

/**
 * Parse an FCS TEXT segment into keyword/value pairs.
 *
 * The delimiter is per-file (both `/` and `\` occur in the fixtures) and is
 * whatever byte sits at `begin`. Values are stored verbatim, including
 * whitespace: `$DATE` is a single space in both sample files.
 *
 * The hard part is the doubled delimiter, which is ambiguous. It means either
 * an escaped literal delimiter, or a key immediately followed by an empty
 * value. Both occur in the wild, and the real CyTOF fixture contains
 *
 *     /$DATE/ /$FIL//$BTIM/20:05:53/
 *
 * where `$FIL` has an empty value. An escape-first parser reads that as
 * `$FIL = "/$BTIM"` and then takes `20:05:53` as a *key*, desynchronising
 * key/value parity so every subsequent keyword in the file is wrong.
 *
 * Rule used here: a doubled delimiter terminates an empty value if and only if
 * the token currently accumulating is a key (an even number of tokens emitted
 * so far) and that key is non-empty. Otherwise it is an escaped delimiter.
 *
 * This also handles the converse case correctly. Given `/$FIL///data.fcs/`,
 * the first pair splits off the key, and the second pair is then seen while
 * accumulating a *value* (odd parity), so it is treated as an escape and
 * yields `$FIL = "/data.fcs"`.
 */
export function parseTextSegment(
	bytes: Uint8Array,
	begin: number,
	end: number,
	warnings: FcsWarning[],
): TextSegment {
	if (begin >= bytes.length) {
		throw new FcsParseError('FCS_BAD_TEXT', `TEXT segment begins at byte ${begin}, past the end of the file.`);
	}

	let last = end;
	if (last >= bytes.length) {
		warn(
			warnings,
			'TEXT_TRUNCATED',
			`TEXT segment claims to end at byte ${end} but the file is ${bytes.length} bytes; reading what is there.`,
		);
		last = bytes.length - 1;
	}

	const delimByte = bytes[begin]!;
	const delimiter = String.fromCharCode(delimByte);
	if (delimByte < 1 || delimByte > 126) {
		throw new FcsParseError('FCS_BAD_TEXT', `TEXT delimiter byte 0x${delimByte.toString(16)} is outside the legal range 1-126.`);
	}
	if (/[A-Za-z0-9]/.test(delimiter)) {
		warn(warnings, 'ODD_DELIMITER', `TEXT delimiter "${delimiter}" is alphanumeric, which the FCS standard forbids.`);
	}

	const tokens: string[] = [];
	/** Byte offset where the token currently being accumulated started. */
	let tokenStart = begin + 1;
	/** Text accumulated from earlier fragments when escapes split a token. */
	let carried = '';
	let ambiguousKey: string | undefined;

	const flush = (upTo: number): string => {
		const text = carried + decodeLatin1(bytes, tokenStart, upTo);
		carried = '';
		return text;
	};

	let i = begin + 1;
	while (i <= last) {
		if (bytes[i] !== delimByte) {
			i++;
			continue;
		}

		const doubled = i + 1 <= last && bytes[i + 1] === delimByte;
		if (doubled) {
			const accumulating = flush(i);
			const isKey = tokens.length % 2 === 0;
			if (isKey && accumulating !== '') {
				// Key, then an empty value. Emit the key here and let the second
				// delimiter be processed normally, which emits the empty value.
				tokens.push(accumulating);
				ambiguousKey = accumulating;
				tokenStart = i + 1;
				i += 1;
				continue;
			}
			// Escaped literal delimiter: keep accumulating the same token.
			carried = accumulating + delimiter;
			tokenStart = i + 2;
			i += 2;
			continue;
		}

		if (ambiguousKey !== undefined && tokens.length % 2 === 1 && tokenStart === i) {
			warn(
				warnings,
				'EMPTY_VALUE_AMBIGUITY',
				`Keyword ${ambiguousKey} has an empty value written as a doubled delimiter; read as empty rather than as an escaped "${delimiter}".`,
				ambiguousKey,
			);
			ambiguousKey = undefined;
		}
		tokens.push(flush(i));
		tokenStart = i + 1;
		i++;
	}

	// A trailing delimiter is normal; anything after it is a final unterminated token.
	if (tokenStart <= last || carried !== '') {
		tokens.push(flush(last + 1));
	}

	if (tokens.length % 2 === 1) {
		const dangling = tokens.pop()!;
		warn(
			warnings,
			'ODD_TOKEN_COUNT',
			`TEXT segment has an odd number of tokens; dropping the trailing fragment "${dangling.slice(0, 40)}".`,
		);
	}

	const keywords: Record<string, string> = {};
	for (let t = 0; t < tokens.length; t += 2) {
		const key = tokens[t]!.trim().toUpperCase();
		if (key === '') {
			continue;
		}
		keywords[key] = tokens[t + 1]!;
	}

	return { keywords, delimiter };
}
