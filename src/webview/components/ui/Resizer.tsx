import { useRef } from 'react';
import { clampWidth, type SidebarLimits } from '../../state/layout';
import { beginLayoutDrag, endLayoutDrag } from '../../render/layoutDrag';
import './Resizer.css';

interface Props {
	/** Which side of this splitter the panel being resized is on. */
	panel: 'before' | 'after';
	/** CSS custom property the panel's width reads from, set on the container. */
	cssVar: string;
	width: number;
	limits: SidebarLimits;
	/** Called once, when the drag ends -- not on every pointer move. */
	onCommit: (px: number) => void;
	label: string;
}

/**
 * A draggable border between a sidebar and the content beside it.
 *
 * The width lives in the reducer, but a dispatch per pointermove would
 * re-render the whole app and, worse, make every Plotly card resize inside the
 * same task. So the drag writes the CSS variable straight onto the container
 * and commits to the reducer once, on pointerup: the layout follows the
 * pointer at the browser's own frame rate and React sees one update.
 *
 * The container is `parentElement` because this element is always a flex child
 * of the row it splits. Passing a ref down would work too, but this keeps the
 * two call sites free of plumbing.
 */
export function Resizer({ panel, cssVar, width, limits, onCommit, label }: Props): React.ReactElement {
	const drag = useRef<{ startX: number; startWidth: number; container: HTMLElement } | undefined>(undefined);

	const apply = (container: HTMLElement, px: number): number => {
		const next = clampWidth(px, limits, container.clientWidth);
		container.style.setProperty(cssVar, `${next}px`);
		return next;
	};

	const onPointerDown = (e: React.PointerEvent<HTMLDivElement>): void => {
		const container = e.currentTarget.parentElement;
		if (!container || e.button !== 0) {
			return;
		}
		drag.current = { startX: e.clientX, startWidth: width, container };
		// Plots hold their last size, and skip layout entirely, for the length
		// of the gesture. See layoutDrag.
		beginLayoutDrag();
		// Capture, so the drag survives the pointer crossing a Plotly canvas or
		// leaving the window -- both of which otherwise eat the move events.
		e.currentTarget.setPointerCapture(e.pointerId);
		e.preventDefault();
	};

	const onPointerMove = (e: React.PointerEvent<HTMLDivElement>): void => {
		const d = drag.current;
		if (!d) {
			return;
		}
		const delta = e.clientX - d.startX;
		apply(d.container, d.startWidth + (panel === 'before' ? delta : -delta));
	};

	const end = (e: React.PointerEvent<HTMLDivElement>): void => {
		const d = drag.current;
		if (!d) {
			return;
		}
		drag.current = undefined;
		endLayoutDrag();
		e.currentTarget.releasePointerCapture(e.pointerId);
		const delta = e.clientX - d.startX;
		onCommit(clampWidth(d.startWidth + (panel === 'before' ? delta : -delta), limits, d.container.clientWidth));
	};

	// A splitter that only answers to a mouse is unusable for anyone driving
	// the panel from the keyboard, and the arrow keys are the documented
	// interaction for role="separator".
	const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>): void => {
		const step = e.shiftKey ? 64 : 16;
		const towards = e.key === 'ArrowLeft' ? -1 : e.key === 'ArrowRight' ? 1 : 0;
		if (towards === 0 && e.key !== 'Home') {
			return;
		}
		e.preventDefault();
		const container = e.currentTarget.parentElement;
		const next = e.key === 'Home'
			? limits.default
			: width + towards * step * (panel === 'before' ? 1 : -1);
		onCommit(clampWidth(next, limits, container?.clientWidth));
	};

	return (
		<div
			className="resizer"
			role="separator"
			aria-orientation="vertical"
			aria-label={label}
			aria-valuenow={width}
			aria-valuemin={limits.min}
			aria-valuemax={limits.max}
			tabIndex={0}
			onPointerDown={onPointerDown}
			onPointerMove={onPointerMove}
			onPointerUp={end}
			onPointerCancel={end}
			onKeyDown={onKeyDown}
			onDoubleClick={() => onCommit(limits.default)}
			title={`${label} — drag to resize, double-click to reset`}
		/>
	);
}
