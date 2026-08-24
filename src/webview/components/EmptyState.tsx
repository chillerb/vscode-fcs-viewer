import type { SampleSummary } from '../../common/protocol';
import { postToHost } from '../vscodeApi';
import './EmptyState.css';

/**
 * Shown whenever no sample is loaded.
 *
 * Distinguishing "nothing loaded yet" from "everything failed" matters: keying
 * only off samples.length left the panel showing "Loading…" forever when the
 * one sample failed to parse, or when a restored file had been moved.
 */
export function EmptyState({ samples }: { samples: SampleSummary[] }): React.ReactElement {
	const failed = samples.filter((s) => s.error);
	const allFailed = samples.length > 0 && failed.length === samples.length;

	if (samples.length > 0 && !allFailed) {
		return <div className="fullscreen dim">Loading…</div>;
	}

	return (
		<div className="fullscreen empty-state">
			{allFailed ? (
				<>
					<h1>Nothing could be loaded</h1>
					<ul className="empty-errors">
						{failed.map((s) => (
							<li key={s.id}>
								<strong>{s.fileName}</strong> <span className="dim">{s.error}</span>
							</li>
						))}
					</ul>
				</>
			) : (
				<h1>No samples loaded</h1>
			)}
			<button type="button" className="primary" onClick={() => postToHost({ type: 'webview/addSample' })}>
				Add FCS files…
			</button>
			<p className="dim">or double-click a .fcs file in the Explorer</p>
		</div>
	);
}
