import { useEffect, useRef, useState } from 'react';

interface Props {
	label?: string;
	/** Explanatory text, shown on hover rather than as a paragraph below. */
	title?: string;
	value: number;
	min?: number;
	onCommit: (v: number) => void;
	disabled?: boolean;
	width?: number;
}

/**
 * Uncontrolled while typing, committed on blur/Enter after a debounce.
 * Typing "1" on the way to "150" must not re-render every card at cofactor 1.
 *
 * type=text with inputMode=decimal rather than type=number: the spinner
 * ignores VS Code theming and swallows scroll events over the field.
 */
export function NumberField({ label, title, value, min, onCommit, disabled, width = 64 }: Props): React.ReactElement {
	const [text, setText] = useState(String(value));
	const [invalid, setInvalid] = useState(false);

	// Re-sync from the prop by adjusting state during render rather than in an
	// effect. An effect would render once with the stale text, then again with
	// the new -- visible as a flicker when a card's axis is re-derived, and the
	// cascading-render pattern the hooks lint rejects.
	const [lastValue, setLastValue] = useState(value);
	if (value !== lastValue) {
		setLastValue(value);
		setText(String(value));
		setInvalid(false);
	}

	const commit = (raw: string): void => {
		const n = Number(raw);
		if (!Number.isFinite(n) || (min !== undefined && n < min)) {
			setInvalid(true);
			return;
		}
		setInvalid(false);
		if (n !== value) {
			onCommit(n);
		}
	};

	// The debounce must survive the parent re-rendering, and callers pass an
	// inline arrow for onCommit, so `commit` has a new identity every render.
	// Reading it through a ref keeps it out of the dependency array; listing it
	// there would restart the timer on every render and the debounce would
	// never fire.
	const commitRef = useRef(commit);
	useEffect(() => {
		commitRef.current = commit;
	});

	useEffect(() => {
		if (text === String(value)) {
			return;
		}
		const t = window.setTimeout(() => commitRef.current(text), 250);
		return () => clearTimeout(t);
	}, [text, value]);

	return (
		<label className="number-field" title={title}>
			{label !== undefined && <span className="dim">{label}</span>}
			<input
				type="text"
				inputMode="decimal"
				disabled={disabled}
				value={text}
				style={{ width, borderColor: invalid ? 'var(--fcs-error)' : undefined }}
				onChange={(e) => setText(e.target.value)}
				onBlur={() => commit(text)}
				onKeyDown={(e) => e.key === 'Enter' && commit(text)}
			/>
		</label>
	);
}
