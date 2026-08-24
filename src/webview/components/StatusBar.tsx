import { useState } from 'react';
import type { FcsWarning } from '../../common/fcs/errors';
import type { AppState } from '../state/appReducer';
import './StatusBar.css';

interface Props {
	status: AppState['status'];
	error: AppState['error'];
	mapping: AppState['mapping'];
	warnings: FcsWarning[];
	pendingSampleN: number | null | undefined;
	sampledCount: number | undefined;
	eventCount: number | undefined;
	/** The global setting. */
	compensate: boolean;
	/** Whether the active sample can honour it. */
	canCompensate: boolean | undefined;
	fileName: string | undefined;
}

interface Message {
	id: string;
	tone: 'error' | 'warn' | 'info';
	label: string;
	detail: React.ReactNode;
}

/**
 * A fixed bottom bar for everything that is a message rather than content.
 *
 * These used to sit between the tab bar and the view, where they pushed the
 * plots down by a different amount for every sample -- switching samples moved
 * the whole grid. A bar of constant height at the edge of the window keeps the
 * content still, and matches where VS Code itself puts status. Details open
 * upward in a drawer so reading one still does not disturb the layout.
 */
export function StatusBar({
	status, error, mapping, warnings, pendingSampleN, sampledCount, eventCount,
	compensate, canCompensate, fileName,
}: Props): React.ReactElement {
	const [openId, setOpenId] = useState<string | undefined>();

	const messages: Message[] = [];
	if (error) {
		messages.push({ id: 'error', tone: 'error', label: 'Load failed', detail: error.message });
	}
	if (mapping && mapping.unresolved.length > 0) {
		messages.push({
			id: 'unresolved',
			tone: 'warn',
			label: `${mapping.unresolved.length} channel${mapping.unresolved.length === 1 ? '' : 's'} missing`,
			detail: (
				<>
					Not present in this sample: <span className="mono">{mapping.unresolved.join(', ')}</span>. Cards using
					them are greyed out; pick another channel in the inspector to plot them.
				</>
			),
		});
	}
	if (mapping && mapping.approximate.length > 0) {
		messages.push({
			id: 'approximate',
			tone: 'warn',
			label: `${mapping.approximate.length} matched by name`,
			detail: <>Matched by name similarity: <span className="mono">{mapping.approximate.join(', ')}</span>.</>,
		});
	}
	if (compensate && canCompensate === false) {
		messages.push({
			id: 'no-spillover',
			tone: 'warn',
			label: 'Not compensated',
			detail: (
				<>
					Compensation is on, but <span className="mono">{fileName}</span> has no usable spillover
					matrix (<span className="mono">$SPILLOVER</span>, <span className="mono">$SPILL</span> or a
					bare <span className="mono">SPILL</span>), so its values are shown raw. The setting stays on
					for the samples that do have one.
				</>
			),
		});
	}
	if (warnings.length > 0) {
		messages.push({
			id: 'warnings',
			tone: 'info',
			label: `${warnings.length} parse issue${warnings.length === 1 ? '' : 's'}`,
			detail: (
				<ul className="status-list">
					{warnings.map((w, i) => (
						<li key={i}><span className="mono">{w.code}</span> {w.message}</li>
					))}
				</ul>
			),
		});
	}

	const open = messages.find((m) => m.id === openId);
	const activity = pendingSampleN !== undefined
		? `Loading ${(pendingSampleN ?? eventCount ?? 0).toLocaleString()} events…`
		: status === 'loading'
			? 'Loading sample…'
			: sampledCount !== undefined && eventCount !== undefined
				? `${sampledCount.toLocaleString()} of ${eventCount.toLocaleString()} events`
				: 'No sample';

	return (
		<>
			{open && (
				<div className={`status-drawer ${open.tone}`} role="status">
					<div className="status-drawer-body">{open.detail}</div>
					<button type="button" title="Dismiss" onClick={() => setOpenId(undefined)}>×</button>
				</div>
			)}
			<footer className="status-bar">
				<span className={`status-activity${pendingSampleN !== undefined || status === 'loading' ? ' busy' : ''}`}>
					{activity}
				</span>
				<span className="status-messages">
					{messages.length === 0 ? (
						<span className="dim">No issues</span>
					) : (
						messages.map((m) => (
							<button
								key={m.id}
								type="button"
								className={`status-chip ${m.tone}${openId === m.id ? ' open' : ''}`}
								aria-expanded={openId === m.id}
								onClick={() => setOpenId(openId === m.id ? undefined : m.id)}
							>
								{m.label}
							</button>
						))
					)}
				</span>
			</footer>
		</>
	);
}
