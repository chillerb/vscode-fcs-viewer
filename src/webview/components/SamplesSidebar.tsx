import { memo } from 'react';
import type { SampleSummary } from '../../common/protocol';
import { postToHost } from '../vscodeApi';
import './SamplesSidebar.css';

interface Props {
	samples: SampleSummary[];
	activeId: string | undefined;
	loading: boolean;
}

/**
 * Exactly one sample is active. Selecting another makes the host post that
 * sample's matrix and discard the previous one, so plot cards persist and
 * simply redraw against the new file.
 */
export const SamplesSidebar = memo(function SamplesSidebar({ samples, activeId, loading }: Props) {
	return (
		<nav className="samples" aria-label="Samples">
			<div className="samples-head">
				<span>Samples</span>
				<button type="button" title="Add FCS files" onClick={() => postToHost({ type: 'webview/addSample' })}>
					+
				</button>
			</div>
			<ul className="samples-list">
				{samples.map((s) => {
					const active = s.id === activeId;
					return (
						<li key={s.id}>
							<button
								type="button"
								className={`sample${active ? ' active' : ''}${s.error ? ' failed' : ''}`}
								aria-current={active}
								title={s.error ?? s.uri}
								onClick={() => !active && postToHost({ type: 'webview/selectSample', id: s.id })}
							>
								<span className="sample-name">{s.fileName}</span>
								<span className="sample-meta dim">
									{s.error
										? 'failed to load'
										: `${s.eventCount.toLocaleString()} events · ${s.channelCount} ch`}
								</span>
								{active && loading && <span className="sample-spinner" aria-label="Loading" />}
							</button>
							<button
								type="button"
								className="sample-remove"
								title={`Remove ${s.fileName}`}
								onClick={() => postToHost({ type: 'webview/removeSample', id: s.id })}
							>
								×
							</button>
						</li>
					);
				})}
			</ul>
			{samples.length === 0 && <p className="samples-empty dim">No samples loaded.</p>}
		</nav>
	);
});
