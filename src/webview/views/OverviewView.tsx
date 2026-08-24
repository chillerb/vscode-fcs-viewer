import { memo, useMemo, useState } from 'react';
import { integer, significant } from '../../common/format';
import type { SampleData } from '../state/SampleData';
import './OverviewView.css';

const num = (v: number): string => significant(v, 4);
const int = integer;

function Value({ v }: { v: number }) {
	return <span className="mono">{Number.isFinite(v) ? num(v) : '—'}</span>;
}

/**
 * Metadata and statistics merged into one page: both are reference material
 * for the same file and read naturally as a single document.
 */
export const OverviewView = memo(function OverviewView({ data, compensate }: { data: SampleData; compensate: boolean }) {
	const [showKeywords, setShowKeywords] = useState(false);
	const meta = data.metadata;
	const sp = meta.spillover;

	const spilloverSet = useMemo(() => new Set(sp?.channelIndices ?? []), [sp]);

	return (
		<div className="overview">
			<section>
				<h2>File</h2>
				<dl className="facts">
					<dt>Name</dt><dd>{data.fileName}</dd>
					<dt>FCS version</dt><dd>{meta.version}</dd>
					<dt>Events</dt><dd>{int(data.eventCount)}</dd>
					<dt>Channels</dt><dd>{data.channelCount}</dd>
					<dt>Data type</dt><dd>{meta.dataType} · {meta.endianness}-endian · $BYTEORD {meta.byteOrd}</dd>
					<dt>Cytometer</dt><dd>{meta.cytometer ?? '—'}{meta.cytometerSerial ? ` (${meta.cytometerSerial})` : ''}</dd>
					<dt>Software</dt><dd>{meta.software ?? '—'}</dd>
					<dt>Acquired</dt><dd>{[meta.acquisitionDate, meta.beginTime, meta.endTime].filter((s) => s && s.trim()).join(' ') || '—'}</dd>
					{meta.timestep !== undefined && <><dt>$TIMESTEP</dt><dd>{meta.timestep} s</dd></>}
					<dt>Size</dt><dd>{(meta.byteSize / 1048576).toFixed(1)} MB</dd>
				</dl>
			</section>

			<section>
				<h2>Channels and statistics</h2>
				<p className="dim note">
					Statistics are computed on {compensate && data.canCompensate ? 'compensated' : 'raw'} values across all {int(data.eventCount)} events,
					independent of the plot subsample.
				</p>
				<div className="table-scroll">
					<table>
						<thead>
							<tr>
								<th>#</th><th>$PnN</th><th>$PnS</th><th>Range</th><th>Amp</th>
								<th>Min</th><th>Max</th><th>Mean</th><th>SD</th>
								<th>P1</th><th>Q1</th><th>Median</th><th>Q3</th><th>P99</th>
								<th title="Events equal to zero">Zeros</th>
								<th title="Events below zero">Neg</th>
							</tr>
						</thead>
						<tbody>
							{meta.channels.map((c) => {
								const s = data.stats[c.index];
								return (
									<tr key={c.index}>
										<td className="dim">{c.n}</td>
										<td>
											{c.name}
											{spilloverSet.has(c.index) && <span className="badge" title="Covered by the spillover matrix">comp</span>}
										</td>
										<td>{c.label ?? <span className="dim">—</span>}</td>
										<td className="mono">{int(c.range)}</td>
										<td className="dim">{c.amplification === 'log' ? `log ${c.logDecades}` : 'lin'}</td>
										<td><Value v={s?.min ?? NaN} /></td>
										<td><Value v={s?.max ?? NaN} /></td>
										<td><Value v={s?.mean ?? NaN} /></td>
										<td><Value v={s?.std ?? NaN} /></td>
										<td><Value v={s?.p1 ?? NaN} /></td>
										<td><Value v={s?.q1 ?? NaN} /></td>
										<td><Value v={s?.median ?? NaN} /></td>
										<td><Value v={s?.q3 ?? NaN} /></td>
										<td><Value v={s?.p99 ?? NaN} /></td>
										<td className="mono">{int(s?.zeroCount ?? 0)}</td>
										<td className="mono">{int(s?.negativeCount ?? 0)}</td>
									</tr>
								);
							})}
						</tbody>
					</table>
				</div>
			</section>

			<section>
				<h2>Compensation</h2>
				{sp === undefined ? (
					<p className="dim">No spillover matrix in file.</p>
				) : (
					<>
						<p className="dim note">
							Read from <span className="mono">{sp.source}</span>: {sp.size} of {data.channelCount} channels.
							Channels outside the matrix are never modified.
						</p>
						<div className="table-scroll">
							<table className="matrix">
								<thead>
									<tr>
										<th />
										{sp.channels.map((c) => <th key={c} className="mono">{c}</th>)}
									</tr>
								</thead>
								<tbody>
									{sp.channels.map((rowName, i) => (
										<tr key={rowName}>
											<th className="mono">{rowName}</th>
											{sp.channels.map((colName, j) => {
												const v = sp.matrix[i * sp.size + j]!;
												return (
													<td key={colName} className="mono" data-diag={i === j || undefined}>
														{v === 0 ? <span className="dim">0</span> : num(v)}
													</td>
												);
											})}
										</tr>
									))}
								</tbody>
							</table>
						</div>
					</>
				)}
			</section>

			<section>
				<h2>
					Keywords
					<button type="button" className="link" onClick={() => setShowKeywords((v) => !v)}>
						{showKeywords ? 'hide' : `show all ${Object.keys(meta.keywords).length}`}
					</button>
				</h2>
				{showKeywords && (
					<div className="table-scroll keywords">
						<table>
							<tbody>
								{Object.entries(meta.keywords).map(([k, v]) => (
									<tr key={k}>
										<th className="mono">{k}</th>
										<td className="mono">{v === '' ? <span className="dim">(empty)</span> : v}</td>
									</tr>
								))}
							</tbody>
						</table>
					</div>
				)}
			</section>
		</div>
	);
});
