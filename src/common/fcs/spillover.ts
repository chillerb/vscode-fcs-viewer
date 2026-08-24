import { warn, type FcsWarning } from './errors';
import type { FcsChannel, FcsSpillover } from './types';

const SOURCES: Array<FcsSpillover['source']> = ['$SPILLOVER', '$SPILL', 'SPILL'];

function normalise(s: string): string {
	return s.trim().toLowerCase().replace(/[-_.\s]/g, '');
}

/**
 * Parse a spillover matrix. Vendors disagree on the keyword: FCS3.1 specifies
 * $SPILLOVER, FCS3.0 files commonly use $SPILL, and BD FACSDiva writes a bare
 * SPILL with no leading $ (which is what data/001.fcs contains).
 *
 * Never throws. Compensation is optional, so a malformed matrix degrades to a
 * warning and no compensation rather than an unopenable file.
 */
export function parseSpillover(
	kw: Record<string, string>,
	channels: FcsChannel[],
	warnings: FcsWarning[],
): FcsSpillover | undefined {
	let source: FcsSpillover['source'] | undefined;
	let raw: string | undefined;
	for (const key of SOURCES) {
		const v = kw[key];
		if (v !== undefined && v.trim() !== '') {
			source = key;
			raw = v;
			break;
		}
	}
	if (source === undefined || raw === undefined) {
		return undefined;
	}

	const tokens = raw.split(',').map((t) => t.trim());
	const size = Number(tokens[0]);
	if (!Number.isInteger(size) || size <= 0) {
		warn(warnings, 'SPILLOVER_INVALID', `${source} does not begin with a channel count; ignoring it.`, source);
		return undefined;
	}
	const expected = 1 + size + size * size;
	if (tokens.length !== expected) {
		warn(warnings, 'SPILLOVER_INVALID', `${source} declares ${size} channels but has ${tokens.length} tokens instead of ${expected}; ignoring it.`, source);
		return undefined;
	}

	const names = tokens.slice(1, 1 + size);
	const byName = new Map<string, number>();
	for (const c of channels) {
		byName.set(normalise(c.name), c.index);
		if (c.label !== undefined) {
			byName.set(`s:${normalise(c.label)}`, c.index);
		}
	}

	const channelIndices: number[] = [];
	for (const name of names) {
		let idx = byName.get(normalise(name));
		if (idx === undefined) {
			idx = byName.get(`s:${normalise(name)}`);
			if (idx !== undefined) {
				warn(warnings, 'SPILLOVER_INVALID', `${source} names "${name}", which matches a $PnS label rather than a $PnN detector name.`, source);
			}
		}
		if (idx === undefined) {
			warn(warnings, 'SPILLOVER_INVALID', `${source} names "${name}", which is not a channel in this file; ignoring the matrix.`, source);
			return undefined;
		}
		channelIndices.push(idx);
	}

	const matrix = new Float64Array(size * size);
	for (let i = 0; i < size * size; i++) {
		const v = Number(tokens[1 + size + i]);
		if (!Number.isFinite(v)) {
			warn(warnings, 'SPILLOVER_INVALID', `${source} contains the non-numeric entry "${tokens[1 + size + i]}"; ignoring the matrix.`, source);
			return undefined;
		}
		matrix[i] = v;
	}

	return { source, channels: names, channelIndices, size, matrix };
}
