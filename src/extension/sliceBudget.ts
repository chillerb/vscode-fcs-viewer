/**
 * How many events may cross the wire, and what to do when more are asked for.
 *
 * Pure arithmetic over a channel count and a byte ceiling, deliberately kept
 * free of vscode so it can be unit-tested. It used to live inside the panel
 * class, where the only way to exercise it was to launch a VS Code host and
 * drive a webview.
 */

/** Bytes per delivered event: 4 per channel value, plus 4 for its event id. */
export function bytesPerEvent(channelCount: number): number {
	return channelCount * 4 + 4;
}

/**
 * Rows that fit in the budget.
 *
 * Floored at 1,000 on purpose: a file with hundreds of channels can compute a
 * budget of a handful of events, and a plot of five cells is useless in a way
 * a slightly oversized transfer is not.
 */
export function budgetRows(channelCount: number, maxBytes: number): number {
	return Math.max(1000, Math.floor(maxBytes / bytesPerEvent(channelCount)));
}

export interface SliceRequest {
	/** Events asked for; null means the whole file. */
	requested: number | null;
	eventCount: number;
	channelCount: number;
	maxBytes: number;
	/** The user has explicitly approved a transfer this large. */
	confirmed: boolean;
}

export interface SliceDecision {
	/** Rows to gather; null means every event. */
	rows: number | null;
	/** True when the host served fewer rows than asked for. */
	clamped: boolean;
}

/**
 * Decide how many rows to actually serve.
 *
 * An unconfirmed over-budget request is served clamped rather than refused:
 * the usual cause is a persisted subsample size from a session on a faster
 * connection, and freezing the tunnel for thirty seconds is a worse answer to
 * that than showing fewer events and saying so.
 */
export function decideSlice(req: SliceRequest): SliceDecision {
	const budget = budgetRows(req.channelCount, req.maxBytes);
	const asked = req.requested === null ? req.eventCount : req.requested;
	const clamped = !req.confirmed && asked > budget;
	return { rows: clamped ? budget : req.requested, clamped };
}
