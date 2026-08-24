export function MissingChannel({ names }: { names: string[] }): React.ReactElement {
	return (
		<div className="plot-missing dim">
			Channel {names.join(' and ')} {names.length > 1 ? 'are' : 'is'} not in this sample.
			<br />
			Pick another channel in the inspector to plot it here.
		</div>
	);
}

interface BadgeProps {
	hidden: number;
	zoomed: boolean;
	/** Set when WebGL is unavailable and the point count was reduced. */
	capped?: { shown: number; total: number };
	onReset: () => void;
}

export function PlotBadges({ hidden, zoomed, capped, onReset }: BadgeProps): React.ReactElement | null {
	if (hidden === 0 && !zoomed && !capped) {
		return null;
	}
	return (
		<div className="plot-badge">
			{capped && (
				<span title="WebGL is unavailable in this window, so this dot plot is drawn as SVG and limited for responsiveness. Every card shows the same cells, so they remain comparable.">
					{capped.shown.toLocaleString()} of {capped.total.toLocaleString()} shown
				</span>
			)}
			{hidden > 0 && (
				<span title="Values a log axis cannot represent are excluded, never clamped onto the edge">
					{hidden.toLocaleString()} ≤ 0 hidden — try arsinh
				</span>
			)}
			{zoomed && (
				<button type="button" onClick={onReset} title="Reset the axes (or double-click the plot)">
					reset zoom
				</button>
			)}
		</div>
	);
}
