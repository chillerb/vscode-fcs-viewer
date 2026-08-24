import { FcsParseError, warn, type FcsWarning } from './errors';
import { parseByteOrd } from './byteOrder';
import type { ChannelKind, FcsChannel, FcsDataType, FcsHeader, FcsMetadata, FcsMode } from './types';

function required(kw: Record<string, string>, key: string): string {
	const v = kw[key];
	if (v === undefined || v.trim() === '') {
		throw new FcsParseError('FCS_MISSING_KEYWORD', `Required FCS keyword ${key} is missing.`, {
			keyword: key,
			hint: 'The file is malformed or was written by a non-conforming instrument.',
		});
	}
	return v.trim();
}

function num(kw: Record<string, string>, key: string, fallback?: number): number {
	const raw = kw[key];
	if (raw === undefined || raw.trim() === '') {
		if (fallback !== undefined) {
			return fallback;
		}
		throw new FcsParseError('FCS_MISSING_KEYWORD', `Required FCS keyword ${key} is missing.`, { keyword: key });
	}
	const v = Number(raw.trim());
	if (!Number.isFinite(v)) {
		if (fallback !== undefined) {
			return fallback;
		}
		throw new FcsParseError('FCS_BAD_TEXT', `FCS keyword ${key} has non-numeric value "${raw}".`, { keyword: key });
	}
	return v;
}

function classifyChannel(name: string, label: string | undefined): ChannelKind {
	const n = name.toLowerCase();
	if (n === 'time' || n === 'event_length' || n === 'eventlength') {
		return 'time';
	}
	if (/^(fsc|ssc)[-_ ]?[ahwt]?$/.test(n)) {
		return 'scatter';
	}
	return label !== undefined && label.trim() !== '' ? 'marker' : 'other';
}

function parseChannels(kw: Record<string, string>, par: number, dataType: FcsDataType, warnings: FcsWarning[]): FcsChannel[] {
	const channels: FcsChannel[] = [];
	for (let n = 1; n <= par; n++) {
		let name = kw[`$P${n}N`]?.trim();
		if (name === undefined || name === '') {
			warn(warnings, 'MISSING_PNN', `Channel ${n} has no $P${n}N; using "P${n}".`, `$P${n}N`);
			name = `P${n}`;
		}
		const rawLabel = kw[`$P${n}S`]?.trim();
		const label = rawLabel === undefined || rawLabel === '' ? undefined : rawLabel;
		const bits = num(kw, `$P${n}B`);
		const range = num(kw, `$P${n}R`, 0);

		let logDecades = 0;
		let logOffset = 0;
		const pnE = kw[`$P${n}E`]?.trim();
		if (pnE !== undefined && pnE !== '') {
			const [f1, f2] = pnE.split(',').map((s) => Number(s.trim()));
			logDecades = Number.isFinite(f1) ? f1! : 0;
			logOffset = Number.isFinite(f2) ? f2! : 0;
		}
		if (logDecades > 0 && logOffset === 0) {
			// FCS3.1 calls f2=0 with f1>0 invalid; every implementation repairs it to 1.
			warn(warnings, 'PNE_ZERO_OFFSET', `$P${n}E declares ${logDecades} decades with a zero offset; using an offset of 1.`, `$P${n}E`);
			logOffset = 1;
		}
		if (logDecades > 0 && (dataType === 'F' || dataType === 'D')) {
			warn(warnings, 'PNE_ON_FLOAT', `$P${n}E declares log amplification on floating-point data; treating channel "${name}" as linear.`, `$P${n}E`);
			logDecades = 0;
			logOffset = 0;
		}

		const gainRaw = kw[`$P${n}G`]?.trim();
		let gain = gainRaw === undefined || gainRaw === '' ? undefined : Number(gainRaw);
		if (gain !== undefined && (!Number.isFinite(gain) || gain === 0)) {
			gain = undefined;
		}
		if (gain !== undefined && gain !== 1 && logDecades > 0) {
			warn(warnings, 'GAIN_WITH_LOG', `Channel "${name}" declares both $P${n}G gain and log amplification; ignoring the gain.`, `$P${n}G`);
			gain = undefined;
		}

		const voltageRaw = kw[`$P${n}V`]?.trim();
		const voltage = voltageRaw === undefined || voltageRaw === '' ? undefined : Number(voltageRaw);

		const channel: FcsChannel = {
			index: n - 1,
			n,
			name,
			displayName: label ?? name,
			bits,
			range,
			amplification: logDecades > 0 ? 'log' : 'linear',
			logDecades,
			logOffset,
			kind: classifyChannel(name, label),
		};
		if (label !== undefined) {
			channel.label = label;
		}
		if (gain !== undefined) {
			channel.gain = gain;
		}
		if (voltage !== undefined && Number.isFinite(voltage)) {
			channel.voltage = voltage;
		}
		channels.push(channel);
	}
	return channels;
}

/**
 * Turn raw keywords into structured metadata and repair the DATA offsets.
 * Does not touch the DATA segment itself.
 */
export function interpretKeywords(
	kw: Record<string, string>,
	header: FcsHeader,
	delimiter: string,
	byteSize: number,
	warnings: FcsWarning[],
): FcsMetadata {
	const mode = required(kw, '$MODE').toUpperCase() as FcsMode;
	if (mode !== 'L') {
		throw new FcsParseError('FCS_UNSUPPORTED_MODE', `FCS $MODE "${mode}" is not supported.`, {
			keyword: '$MODE',
			hint: 'Only list-mode ($MODE L) files can be displayed; correlated and uncorrelated histogram modes were removed in FCS3.1.',
		});
	}

	const dataType = required(kw, '$DATATYPE').toUpperCase() as FcsDataType;
	if (dataType === 'A') {
		throw new FcsParseError('FCS_UNSUPPORTED_DATATYPE', 'ASCII-encoded FCS data ($DATATYPE A) is not supported.', {
			keyword: '$DATATYPE',
			hint: 'Re-export the file as binary ($DATATYPE F, D or I).',
		});
	}
	if (dataType !== 'F' && dataType !== 'D' && dataType !== 'I') {
		throw new FcsParseError('FCS_UNSUPPORTED_DATATYPE', `Unsupported $DATATYPE "${dataType}".`, { keyword: '$DATATYPE' });
	}

	const byteOrd = required(kw, '$BYTEORD');
	const { endianness } = parseByteOrd(byteOrd, warnings);

	const par = num(kw, '$PAR');
	if (!Number.isInteger(par) || par <= 0) {
		throw new FcsParseError('FCS_BAD_TEXT', `$PAR is ${par}; the file declares no channels.`, { keyword: '$PAR' });
	}
	const declaredEventCount = num(kw, '$TOT');

	// Offset repair. FCS3.x writes 0 in the HEADER when an offset does not fit
	// in 8 characters and puts the truth in $BEGINDATA/$ENDDATA.
	const data = { ...header.data };
	const kwBegin = num(kw, '$BEGINDATA', 0);
	const kwEnd = num(kw, '$ENDDATA', 0);
	if (data.begin === 0 || data.begin >= byteSize) {
		data.begin = kwBegin;
		data.end = kwEnd;
	} else if (kwBegin !== 0 && kwBegin !== data.begin) {
		warn(warnings, 'OFFSET_MISMATCH', `HEADER says DATA begins at ${data.begin} but $BEGINDATA says ${kwBegin}; trusting $BEGINDATA.`, '$BEGINDATA');
		data.begin = kwBegin;
		data.end = kwEnd;
	} else if (kwEnd !== 0 && kwEnd !== data.end) {
		// The begins agree but the ends do not. Only the begin used to be
		// compared, so a file with a correct begin and a bogus end went through
		// silently. $ENDDATA wins for the same reason it does above: the
		// HEADER field is the one with a width limit.
		warn(warnings, 'OFFSET_MISMATCH', `HEADER says DATA ends at ${data.end} but $ENDDATA says ${kwEnd}; trusting $ENDDATA.`, '$ENDDATA');
		data.end = kwEnd;
	}
	// A file with $TOT 0 legitimately has an empty (degenerate) DATA segment;
	// only a file that claims events needs a usable one.
	if (declaredEventCount > 0 && (data.begin === 0 || data.end === 0 || data.end < data.begin)) {
		throw new FcsParseError('FCS_BAD_HEADER', 'The file does not declare a usable DATA segment.', {
			hint: 'Both the HEADER offsets and $BEGINDATA/$ENDDATA are missing or inconsistent.',
		});
	}

	const channels = parseChannels(kw, par, dataType, warnings);

	const nextData = num(kw, '$NEXTDATA', 0);
	if (nextData > 0) {
		warn(warnings, 'MULTIPLE_DATASETS', 'The file contains more than one dataset; only the first is shown.', '$NEXTDATA');
	}

	const opt = (key: string): string | undefined => {
		const v = kw[key]?.trim();
		return v === undefined || v === '' ? undefined : v;
	};
	const timestepRaw = opt('$TIMESTEP');
	const timestep = timestepRaw === undefined ? undefined : Number(timestepRaw);

	const meta: FcsMetadata = {
		version: header.version,
		header: { ...header, data },
		keywords: kw,
		delimiter,
		mode,
		dataType,
		byteOrd,
		endianness,
		parameterCount: par,
		eventCount: declaredEventCount,
		declaredEventCount,
		channels,
		nextData,
		warnings,
		byteSize,
	};
	if (timestep !== undefined && Number.isFinite(timestep)) {
		meta.timestep = timestep;
	}
	// Assigned individually rather than spread, so exactOptionalPropertyTypes
	// stays satisfiable and absent keywords stay absent rather than undefined.
	const cytometer = opt('$CYT');
	if (cytometer !== undefined) { meta.cytometer = cytometer; }
	const serial = opt('$CYTSN');
	if (serial !== undefined) { meta.cytometerSerial = serial; }
	const software = opt('CREATOR') ?? opt('$SYS');
	if (software !== undefined) { meta.software = software; }
	const date = opt('$DATE');
	if (date !== undefined) { meta.acquisitionDate = date; }
	const btim = opt('$BTIM');
	if (btim !== undefined) { meta.beginTime = btim; }
	const etim = opt('$ETIM');
	if (etim !== undefined) { meta.endTime = etim; }
	const fil = kw['$FIL'];
	if (fil !== undefined) { meta.originalFile = fil; }
	return meta;
}
