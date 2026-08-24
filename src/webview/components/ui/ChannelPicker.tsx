import { useMemo, useRef, useState } from 'react';
import type { FcsChannel } from '../../../common/fcs/types';
import type { ChannelRef } from '../../state/channelResolver';
import './ChannelPicker.css';

interface Props {
	channels: FcsChannel[];
	value: ChannelRef;
	resolvedIndex: number | undefined;
	onChange: (ref: ChannelRef) => void;
	label: string;
}

const GROUPS: Array<{ kind: FcsChannel['kind']; title: string }> = [
	{ kind: 'marker', title: 'Markers' },
	{ kind: 'other', title: 'Other detectors' },
	{ kind: 'scatter', title: 'Scatter' },
	{ kind: 'time', title: 'Time' },
];

/** Matches against both $PnN and $PnS, since users think in either. */
export function ChannelPicker({ channels, value, resolvedIndex, onChange, label }: Props): React.ReactElement {
	const [open, setOpen] = useState(false);
	const [query, setQuery] = useState('');
	const rootRef = useRef<HTMLDivElement>(null);

	const groups = useMemo(() => {
		const q = query.trim().toLowerCase();
		const match = (c: FcsChannel): boolean =>
			q === '' || c.name.toLowerCase().includes(q) || (c.label?.toLowerCase().includes(q) ?? false);
		return GROUPS.map((g) => ({ ...g, items: channels.filter((c) => c.kind === g.kind && match(c)) }))
			.filter((g) => g.items.length > 0);
	}, [channels, query]);

	const current = resolvedIndex !== undefined ? channels[resolvedIndex] : undefined;

	return (
		<div className="channel-picker" ref={rootRef}>
			<label>{label}</label>
			<button
				type="button"
				className={`channel-button${current ? '' : ' unresolved'}`}
				onClick={() => setOpen((v) => !v)}
				aria-expanded={open}
			>
				{current ? (
					<>
						<span className="primary-name">{current.label ?? current.name}</span>
						{current.label !== undefined && <span className="dim secondary-name">{current.name}</span>}
					</>
				) : (
					<span className="primary-name">{value.name} (not in sample)</span>
				)}
			</button>

			{open && (
				<div className="channel-popover" onKeyDown={(e) => e.key === 'Escape' && setOpen(false)}>
					<input
						type="text"
						autoFocus
						placeholder="Filter by marker or detector…"
						value={query}
						onChange={(e) => setQuery(e.target.value)}
					/>
					<ul>
						{groups.map((g) => (
							<li key={g.kind}>
								<div className="group-title dim">{g.title}</div>
								<ul>
									{g.items.map((c) => (
										<li key={c.index}>
											<button
												type="button"
												className={c.index === resolvedIndex ? 'selected' : ''}
												onClick={() => {
													onChange({ name: c.name, index: c.index, ...(c.label !== undefined ? { label: c.label } : {}) });
													setOpen(false);
													setQuery('');
												}}
											>
												<span className="primary-name">{c.label ?? c.name}</span>
												{c.label !== undefined && <span className="dim secondary-name">{c.name}</span>}
											</button>
										</li>
									))}
								</ul>
							</li>
						))}
						{groups.length === 0 && <li className="dim no-match">No channel matches.</li>}
					</ul>
				</div>
			)}
		</div>
	);
}
