import { warn, type FcsWarning } from './errors';
import type { Endianness } from './types';

export interface ByteOrdSpec {
	endianness: Endianness;
	/** Only set for 'mixed': 0-based source byte index per destination byte. */
	permutation: number[] | null;
	width: number;
}

/**
 * Interpret $BYTEORD. The standard is 1-based (`1,2,3,4` little, `4,3,2,1`
 * big), but 0-based variants (`3,2,1,0`) occur in real files. Genuinely
 * mixed orders get a slow permutation path rather than a rejection -- a slow
 * correct read beats refusing the file.
 */
export function parseByteOrd(byteOrd: string, warnings: FcsWarning[]): ByteOrdSpec {
	const parts = byteOrd.split(',').map((s) => Number(s.trim()));
	if (parts.length === 0 || parts.some((n) => !Number.isInteger(n))) {
		warn(warnings, 'BYTEORD_MIXED', `Unparseable $BYTEORD "${byteOrd}"; assuming little-endian.`, '$BYTEORD');
		return { endianness: 'little', permutation: null, width: 4 };
	}

	let order = parts;
	if (Math.min(...order) === 0) {
		warn(warnings, 'BYTEORD_ZERO_BASED', `$BYTEORD "${byteOrd}" is 0-based; normalising to 1-based.`, '$BYTEORD');
		order = order.map((n) => n + 1);
	}

	const width = order.length;
	const ascending = order.every((n, i) => n === i + 1);
	if (ascending) {
		return { endianness: 'little', permutation: null, width };
	}
	const descending = order.every((n, i) => n === width - i);
	if (descending) {
		return { endianness: 'big', permutation: null, width };
	}

	warn(warnings, 'BYTEORD_MIXED', `$BYTEORD "${byteOrd}" is neither little- nor big-endian; using a slow byte-permutation read.`, '$BYTEORD');
	// order[i] is the 1-based position (in little-endian significance order)
	// that source byte i occupies.
	return { endianness: 'mixed', permutation: order.map((n) => n - 1), width };
}
