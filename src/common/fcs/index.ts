import { FcsParseError, type FcsWarning } from './errors';
import { parseHeader } from './header';
import { parseTextSegment } from './text';
import { interpretKeywords } from './keywords';
import { parseDataSegment } from './data';
import { parseSpillover } from './spillover';
import type { FcsDataset, FcsParseOptions } from './types';

export * from './types';
export * from './errors';
export { parseHeader } from './header';
export { parseTextSegment } from './text';
export { parseByteOrd } from './byteOrder';
export { parseSpillover } from './spillover';
export { invertMatrix, invertSpillover, compensateColumns } from './compensation';

const DEFAULT_MAX_VALUES = 512_000_000;


export function parseFcs(bytes: Uint8Array, options: FcsParseOptions = {}): FcsDataset {
	const warnings: FcsWarning[] = [];
	const header = parseHeader(bytes, warnings);
	const { keywords, delimiter } = parseTextSegment(bytes, header.text.begin, header.text.end, warnings);
	const meta = interpretKeywords(keywords, header, delimiter, bytes.length, warnings);
	const spillover = parseSpillover(keywords, meta.channels, warnings);
	if (spillover !== undefined) {
		meta.spillover = spillover;
	}

	const { matrix, eventCount } = parseDataSegment(
		bytes,
		meta,
		{
			applyScaling: options.applyScaling ?? true,
			maxValues: options.maxValues ?? DEFAULT_MAX_VALUES,
			...(options.signal ? { signal: options.signal } : {}),
		},
		warnings,
	);
	meta.eventCount = eventCount;

	return { metadata: meta, matrix, eventCount, channelCount: meta.channels.length };
}

export { FcsParseError };
