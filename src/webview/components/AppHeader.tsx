import { memo } from 'react';
import type { SampleData } from '../state/SampleData';
import { useDispatch } from '../state/AppStateContext';
import './AppHeader.css';

interface Props {
	data: SampleData | undefined;
	workspaceName: string | undefined;
	sampleN: number | null;
	pendingSampleN: number | null | undefined;
	compensate: boolean;
	maxSliceBytes: number;
	/** Byte size the user has explicitly approved transferring. */
	onConfirmTransfer: (bytes: number) => void;
	confirmedBytes: number | undefined;
}

const SAMPLE_OPTIONS = [1000, 5000, 10000, 25000, 50000, 100000];

/**
 * Global controls only: the things that genuinely apply to every card and view.
 * Transforms are per axis and live in the card inspector, seeded from the
 * channel rather than from a global default.
 */
function formatMB(bytes: number): string {
	return `${(bytes / 1048576).toFixed(bytes < 10 * 1048576 ? 1 : 0)} MB`;
}

export const AppHeader = memo(function AppHeader({
	data,
	workspaceName,
	sampleN,
	pendingSampleN,
	compensate,
	maxSliceBytes,
	onConfirmTransfer,
	confirmedBytes,
}: Props) {
	const dispatch = useDispatch();
	const total = data?.eventCount ?? 0;
	const perEvent = data ? data.channelCount * 4 + 4 : 0;
	const bytesFor = (n: number | null): number => (n === null ? total : Math.min(n, total)) * perEvent;

	// Only the subsample crosses the wire, and on a remote or dev container
	// connection that cost is the difference between instant and a long stall,
	// so an oversized choice is confirmed rather than just applied.
	const wantedBytes = bytesFor(sampleN);
	const needsConfirm = data !== undefined && wantedBytes > maxSliceBytes && confirmedBytes !== wantedBytes;
	const loading = pendingSampleN !== undefined;

	return (
		<header className="app-header">
			<div className="app-title">
				{/* The workspace is what the samples and cards belong to, so it
				    sits above the active sample rather than beside it. */}
				<span className={`workspace-name${workspaceName === undefined ? ' unsaved' : ''}`}>
					{workspaceName ?? 'Unsaved workspace'}
				</span>
				<strong>{data?.fileName ?? 'FCS Viewer'}</strong>
				{data && (
					<span className="dim">
						{total.toLocaleString()} events · {data.channelCount} channels
						{data.metadata.cytometer ? ` · ${data.metadata.cytometer}` : ''}
					</span>
				)}
			</div>

			<div className="app-controls">
				<label>
					Subsample
					<select
						value={sampleN === null ? 'all' : String(sampleN)}
						aria-busy={loading}
						onChange={(e) => dispatch({ type: 'setSampleN', n: e.target.value === 'all' ? null : Number(e.target.value) })}
					>
						{SAMPLE_OPTIONS.filter((n) => n < total).map((n) => (
							<option key={n} value={n}>
								{n.toLocaleString()}
								{bytesFor(n) > maxSliceBytes ? ` · ${formatMB(bytesFor(n))}` : ''}
							</option>
						))}
						<option value="all">
							All{total > 0 ? ` (${total.toLocaleString()})` : ''}
							{bytesFor(null) > maxSliceBytes ? ` · ${formatMB(bytesFor(null))}` : ''}
						</option>
					</select>
				</label>

				{/* Enabled even for a file with no matrix: the setting applies
				    to every sample, so it has to be changeable from whichever
				    one happens to be active. */}
				<label
					className={compensate && data !== undefined && !data.canCompensate ? 'inactive' : undefined}
					title={
						data?.canCompensate
							? `Apply the ${data.metadata.spillover?.source} matrix (${data.metadata.spillover?.size} of ${data.channelCount} channels)`
							: 'This sample has no usable spillover matrix, so its values are shown uncompensated. The setting stays on for samples that do have one.'
					}
				>
					<input
						type="checkbox"
						checked={compensate}
						onChange={(e) => dispatch({ type: 'setCompensate', on: e.target.checked })}
					/>
					Compensate
				</label>
			</div>

			{needsConfirm && (
				<div className="transfer-confirm">
					<span>
						Showing {(sampleN === null ? total : sampleN).toLocaleString()} events means transferring{' '}
						{formatMB(wantedBytes)} to the viewer, which is slow over a remote or dev container connection.
					</span>
					<button type="button" className="primary" onClick={() => onConfirmTransfer(wantedBytes)}>
						Load anyway
					</button>
					<button
						type="button"
						onClick={() => dispatch({ type: 'setSampleN', n: data ? data.sampledCount : 5000 })}
					>
						Cancel
					</button>
				</div>
			)}
		</header>
	);
});
