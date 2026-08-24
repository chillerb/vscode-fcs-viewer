import { memo } from 'react';
import type { TabId } from '../state/appReducer';
import { useDispatch } from '../state/AppStateContext';
import './TabBar.css';

const TABS: Array<{ id: TabId; label: string }> = [
	{ id: 'plots', label: 'Plots' },
	{ id: 'table', label: 'Table' },
	{ id: 'overview', label: 'Overview' },
];

export const TabBar = memo(function TabBar({ active }: { active: TabId }) {
	const dispatch = useDispatch();
	return (
		<div className="tabbar" role="tablist" aria-label="Views">
			{TABS.map((t, i) => (
				<button
					key={t.id}
					role="tab"
					type="button"
					aria-selected={t.id === active}
					tabIndex={t.id === active ? 0 : -1}
					className={t.id === active ? 'tab active' : 'tab'}
					onClick={() => dispatch({ type: 'setTab', tab: t.id })}
					onKeyDown={(e) => {
						if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') {
							return;
						}
						const next = (i + (e.key === 'ArrowRight' ? 1 : TABS.length - 1)) % TABS.length;
						dispatch({ type: 'setTab', tab: TABS[next]!.id });
					}}
				>
					{t.label}
				</button>
			))}
		</div>
	);
});
