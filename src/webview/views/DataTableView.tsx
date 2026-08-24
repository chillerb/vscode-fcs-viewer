import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { fixed2 } from '../../common/format';
import { useAppState, useDispatch } from '../state/AppStateContext';
import { postToHost } from '../vscodeApi';
import './DataTableView.css';

const ROW_H = 22;
const COL_W = 108;
const INDEX_W = 78;
const OVERSCAN = 6;

/** Fixed two decimals, so the column aligns on the decimal point. */
function formatValue(v: number): string {
	if (!Number.isFinite(v)) {
		return Number.isNaN(v) ? '—' : v > 0 ? '∞' : '-∞';
	}
	return fixed2(v);
}

export function DataTableView(): React.ReactElement | null {
	const state = useAppState();
	const dispatch = useDispatch();
	const viewportRef = useRef<HTMLDivElement>(null);
	const headerRef = useRef<HTMLDivElement>(null);
	const [scroll, setScroll] = useState({ top: 0, left: 0 });
	const [box, setBox] = useState({ width: 0, height: 0 });
	const frame = useRef(0);

	const data = state.data;
	const { visibleColumns, sort } = state.table;

	// The table always follows the global subsample, so it shows the same cells
	// the plots do. Rows arrive in permutation order, so the default display
	// order is by original event index -- otherwise the event column jumps.
	const rowIndices = useMemo(() => {
		if (!data) {
			return undefined;
		}
		const rows = data.rows(state.sampleN);
		return rows.length === data.sampledCount ? data.ascendingRows() : rows;
	}, [data, state.sampleN]);
	const rowCount = rowIndices?.length ?? 0;

	const columns = useMemo(
		() => visibleColumns.map((i) => data?.metadata.channels[i]).filter((c) => c !== undefined),
		[visibleColumns, data],
	);

	// Sort a permutation of row slots, never the data itself.
	//
	// The result is tagged with the inputs it was computed from, so `order` and
	// `sorting` are both derived rather than stored. Storing them meant an
	// effect had to clear them whenever the inputs changed, which renders once
	// with a stale order before the correct one arrives.
	const sortKey = sort && data ? `${data.id}:${sort.column}:${sort.dir}:${rowCount}:${String(state.compensate)}` : undefined;
	const [sorted, setSorted] = useState<{ key: string; order: Uint32Array } | undefined>();
	const order = sortKey !== undefined && sorted?.key === sortKey ? sorted.order : undefined;
	const sorting = sortKey !== undefined && order === undefined;

	useEffect(() => {
		if (!data || !sort || sortKey === undefined) {
			return;
		}
		const handle = requestAnimationFrame(() => {
			const col = data.column(sort.column, state.compensate);
			const slots = new Uint32Array(rowCount);
			for (let i = 0; i < rowCount; i++) {
				slots[i] = i;
			}
			const rowOf = (slot: number): number => rowIndices?.[slot] ?? slot;
			// NaN must be handled explicitly: a - b yields NaN, which V8 treats
			// as 0, leaving the order array garbage.
			slots.sort((a, b) => {
				const va = col[rowOf(a)]!;
				const vb = col[rowOf(b)]!;
				const na = Number.isNaN(va);
				const nb = Number.isNaN(vb);
				if (na || nb) {
					return na && nb ? 0 : na ? 1 : -1;
				}
				return va - vb;
			});
			if (sort.dir === 'desc') {
				slots.reverse();
			}
			setSorted({ key: sortKey, order: slots });
		});
		return () => cancelAnimationFrame(handle);
	}, [data, sort, sortKey, rowCount, rowIndices, state.compensate]);

	useEffect(() => {
		const el = viewportRef.current;
		if (!el) {
			return;
		}
		const observer = new ResizeObserver((entries) => {
			const r = entries[0]?.contentRect;
			if (r) {
				setBox({ width: r.width, height: r.height });
			}
		});
		observer.observe(el);
		return () => observer.disconnect();
	}, []);

	const onScroll = useCallback((e: React.UIEvent<HTMLDivElement>) => {
		const el = e.currentTarget;
		// Coalesce into one update per frame; a deferred update shows blank rows.
		cancelAnimationFrame(frame.current);
		frame.current = requestAnimationFrame(() => {
			setScroll({ top: el.scrollTop, left: el.scrollLeft });
			if (headerRef.current) {
				headerRef.current.style.transform = `translateX(${-el.scrollLeft}px)`;
			}
		});
	}, []);

	if (!data) {
		return null;
	}

	const rowStart = Math.max(0, Math.floor(scroll.top / ROW_H) - OVERSCAN);
	const rowEnd = Math.min(rowCount, Math.ceil((scroll.top + box.height) / ROW_H) + OVERSCAN);
	const colStart = Math.max(0, Math.floor(scroll.left / COL_W) - 2);
	const colEnd = Math.min(columns.length, Math.ceil((scroll.left + box.width) / COL_W) + 2);

	const cells: React.ReactElement[] = [];
	for (let r = rowStart; r < rowEnd; r++) {
		const slot = order ? order[r]! : r;
		const row = rowIndices ? rowIndices[slot]! : slot;
		const event = data.eventIds[row] ?? row;
		for (let c = colStart; c < colEnd; c++) {
			const channel = columns[c]!;
			const value = data.column(channel.index, state.compensate)[row]!;
			cells.push(
				<div
					key={`${r}:${c}`}
					className="cell"
					style={{ transform: `translate(${INDEX_W + c * COL_W}px, ${r * ROW_H}px)` }}
				>
					{formatValue(value)}
				</div>,
			);
		}
		cells.push(
			<div key={`i${r}`} className="cell index" style={{ transform: `translate(0px, ${r * ROW_H}px)` }}>
				{(event + 1).toLocaleString()}
			</div>,
		);
	}

	/**
	 * Copy every row of the current subsample, not the rendered window.
	 *
	 * This used to iterate rowStart..rowEnd, so what landed on the clipboard
	 * was however many rows happened to fit in the window -- unreproducible,
	 * and silently a few dozen rows out of thousands.
	 */
	const copyAll = (): void => {
		const cols = columns.map((c) => ({ name: c.name, values: data.column(c.index, state.compensate) }));
		const lines = [['event', ...cols.map((c) => c.name)].join('\t')];
		for (let r = 0; r < rowCount; r++) {
			const slot = order ? order[r]! : r;
			const row = rowIndices ? rowIndices[slot]! : slot;
			const event = data.eventIds[row] ?? row;
			lines.push([event + 1, ...cols.map((c) => c.values[row]!)].join('\t'));
		}
		postToHost({ type: 'webview/copyToClipboard', text: lines.join('\n') });
	};

	return (
		<div className="table-view">
			<div className="table-toolbar">
				<span className="dim">
					{data.sampledCount.toLocaleString()} of {data.eventCount.toLocaleString()} sampled events
					{state.compensate && data.canCompensate && ' · compensated'}
					{sorting && ' · sorting…'}
				</span>
				<details className="column-picker">
					<summary>{columns.length} of {data.channelCount} columns</summary>
					<div className="column-list">
						<div className="column-actions">
							<span className="dim">Show columns:</span>
							<button type="button" onClick={() => dispatch({ type: 'table', patch: { visibleColumns: data.metadata.channels.map((c) => c.index) } })}>All</button>
							<button type="button" title="Channels that carry a $PnS marker label" onClick={() => dispatch({ type: 'table', patch: { visibleColumns: data.metadata.channels.filter((c) => c.kind === 'marker').map((c) => c.index) } })}>Markers</button>
							<button type="button" onClick={() => dispatch({ type: 'table', patch: { visibleColumns: [] } })}>None</button>
						</div>
						{data.metadata.channels.map((c) => (
							<label key={c.index} className="check">
								<input
									type="checkbox"
									checked={visibleColumns.includes(c.index)}
									onChange={(e) => dispatch({
										type: 'table',
										patch: {
											visibleColumns: e.target.checked
												? [...visibleColumns, c.index].sort((a, b) => a - b)
												: visibleColumns.filter((i) => i !== c.index),
										},
									})}
								/>
								{c.label ?? c.name} <span className="dim">{c.label !== undefined ? c.name : ''}</span>
							</label>
						))}
					</div>
				</details>
				<button
					type="button"
					onClick={copyAll}
					title={`Copy all ${rowCount.toLocaleString()} rows and the ${columns.length} shown columns as tab-separated text`}
				>
					Copy {rowCount.toLocaleString()} rows
				</button>
			</div>
			<div className="table-header-clip">
				<div className="table-header" ref={headerRef} style={{ width: INDEX_W + columns.length * COL_W }}>
					<div className="hcell index" style={{ width: INDEX_W }}>event</div>
					{columns.map((c) => {
						const active = sort?.column === c.index;
						return (
							<button
								key={c.index}
								type="button"
								className={`hcell${active ? ' sorted' : ''}`}
								style={{ width: COL_W }}
								title={`${c.name}${c.label !== undefined ? ` · ${c.label}` : ''} — click to sort`}
								onClick={() => dispatch({
									type: 'table',
									patch: {
										sort: active && sort.dir === 'asc'
											? { column: c.index, dir: 'desc' }
											: active && sort.dir === 'desc'
												? null
												: { column: c.index, dir: 'asc' },
									},
								})}
							>
								<span className="hcell-labels">
									<span className="hcell-name">{c.label ?? c.name}</span>
									{c.label !== undefined && <span className="hcell-sub dim">{c.name}</span>}
								</span>
								{active && <span className="sort-arrow">{sort.dir === 'asc' ? '▲' : '▼'}</span>}
							</button>
						);
					})}
				</div>
			</div>

			<div className="table-viewport" ref={viewportRef} onScroll={onScroll}>
				<div
					className="table-spacer"
					style={{ width: INDEX_W + columns.length * COL_W, height: rowCount * ROW_H }}
				>
					{cells}
				</div>
			</div>
		</div>
	);
}
