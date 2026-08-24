/** Fatal conditions: the file cannot be displayed at all. */
export type FcsErrorCode =
	| 'FCS_TRUNCATED'
	| 'FCS_BAD_HEADER'
	| 'FCS_BAD_TEXT'
	| 'FCS_MISSING_KEYWORD'
	| 'FCS_UNSUPPORTED_MODE'
	| 'FCS_UNSUPPORTED_DATATYPE'
	| 'FCS_UNSUPPORTED_BITWIDTH'
	| 'FCS_BAD_BYTEORD'
	| 'FCS_TOO_LARGE'
	| 'FCS_CANCELLED'
	| 'FCS_INTERNAL';

export interface FcsErrorDetail {
	keyword?: string;
	offset?: number;
	/** Actionable next step, appended to the message shown to the user. */
	hint?: string;
}

export class FcsParseError extends Error {
	readonly code: FcsErrorCode;
	readonly detail: FcsErrorDetail;

	constructor(code: FcsErrorCode, message: string, detail: FcsErrorDetail = {}) {
		super(detail.hint ? `${message} ${detail.hint}` : message);
		this.name = 'FcsParseError';
		this.code = code;
		this.detail = detail;
	}
}

/**
 * Non-fatal problems. The file still parses; these surface in the UI as a
 * dismissible banner so silently-repaired vendor quirks stay visible.
 */
export type FcsWarningCode =
	| 'UNKNOWN_VERSION'
	| 'ODD_DELIMITER'
	| 'ODD_TOKEN_COUNT'
	| 'EMPTY_VALUE_AMBIGUITY'
	| 'TEXT_TRUNCATED'
	| 'STEXT_CONFLICT'
	| 'OFFSET_MISMATCH'
	| 'OFFSET_OFF_BY_LESS_THAN_AN_EVENT'
	| 'OFFSET_MISALIGNED'
	| 'EVENT_COUNT_MISMATCH'
	| 'PNE_ZERO_OFFSET'
	| 'PNE_ON_FLOAT'
	| 'GAIN_WITH_LOG'
	| 'BYTEORD_ZERO_BASED'
	| 'BYTEORD_MIXED'
	| 'BITPACK_LE'
	| 'SPILLOVER_INVALID'
	| 'SPILLOVER_SINGULAR'
	| 'MULTIPLE_DATASETS'
	| 'NON_FINITE_VALUES'
	| 'MISSING_PNN';

export interface FcsWarning {
	code: FcsWarningCode;
	message: string;
	keyword?: string;
}

export function warn(
	warnings: FcsWarning[],
	code: FcsWarningCode,
	message: string,
	keyword?: string,
): void {
	warnings.push(keyword === undefined ? { code, message } : { code, message, keyword });
}
