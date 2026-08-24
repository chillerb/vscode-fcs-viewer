/**
 * The handful of number formats the UI actually uses.
 *
 * This replaces d3-format, which was carried purely for five call sites. A
 * specifier parser is a lot of machinery for "two decimals" and "SI prefix";
 * named functions also make the intent readable at the call site, which a
 * string like ',.4~g' never did.
 */

const GROUPED = new Intl.NumberFormat('en-US', { useGrouping: true, maximumFractionDigits: 20 });

/** Group the integer part of an already-rendered decimal string. */
function group(s: string): string {
	const negative = s.startsWith('-');
	const body = negative ? s.slice(1) : s;
	const dot = body.indexOf('.');
	const whole = dot < 0 ? body : body.slice(0, dot);
	const rest = dot < 0 ? '' : body.slice(dot);
	return (negative ? '-' : '') + whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',') + rest;
}

/** d3's ',.2f': grouped, always exactly two decimals. */
export function fixed2(v: number): string {
	return group(v.toFixed(2));
}

/** d3's ',d': grouped integer. */
export function integer(v: number): string {
	return GROUPED.format(Math.round(v));
}

/**
 * d3's ',.4~g' and friends: N significant digits with trailing zeros trimmed,
 * grouped, falling back to exponential at the extremes the way %g does.
 */
export function significant(v: number, digits = 4): string {
	if (!Number.isFinite(v)) {
		return Number.isNaN(v) ? 'NaN' : v > 0 ? '∞' : '-∞';
	}
	if (v === 0) {
		return '0';
	}
	const exponent = Math.floor(Math.log10(Math.abs(v)));
	// The %g rule: exponential below 1e-4 or once the exponent outgrows the
	// requested precision, fixed notation in between.
	if (exponent < -4 || exponent >= digits + 3) {
		return trimExponential(v.toExponential(Math.max(0, digits - 1)));
	}
	return group(trimZeros(v.toFixed(Math.max(0, digits - 1 - exponent))));
}

const SI = [
	{ e: 24, s: 'Y' }, { e: 21, s: 'Z' }, { e: 18, s: 'E' }, { e: 15, s: 'P' },
	{ e: 12, s: 'T' }, { e: 9, s: 'G' }, { e: 6, s: 'M' }, { e: 3, s: 'k' },
	{ e: 0, s: '' }, { e: -3, s: 'm' }, { e: -6, s: 'µ' }, { e: -9, s: 'n' },
	{ e: -12, s: 'p' }, { e: -15, s: 'f' },
];

/** d3's '~s': SI prefix, trailing zeros trimmed. Used for axis tick labels. */
export function siPrefix(v: number): string {
	if (v === 0 || !Number.isFinite(v)) {
		return significant(v);
	}
	const magnitude = Math.floor(Math.log10(Math.abs(v)));
	const unit = SI.find((u) => magnitude >= u.e) ?? SI[SI.length - 1]!;
	const scaled = v / Math.pow(10, unit.e);
	return `${trimZeros(scaled.toPrecision(6))}${unit.s}`;
}

function trimZeros(s: string): string {
	return s.includes('.') ? s.replace(/\.?0+$/, '') : s;
}

function trimExponential(s: string): string {
	const [mantissa, exponent] = s.split('e');
	return `${trimZeros(mantissa!)}e${exponent}`;
}
