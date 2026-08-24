/**
 * Sidebar widths.
 *
 * Kept out of the components because the clamping is the part that can be
 * wrong in ways nobody notices until a small window makes the plots
 * unreachable, and it is pure arithmetic that deserves a test rather than a
 * manual drag.
 */

export interface SidebarLimits {
	/** Narrower than this and the panel's own controls start to overlap. */
	min: number;
	/** Wider than this is not a sidebar any more. */
	max: number;
	/** What a double-click on the splitter goes back to. */
	default: number;
}

export const SAMPLES_LIMITS: SidebarLimits = { min: 140, max: 520, default: 200 };
export const INSPECTOR_LIMITS: SidebarLimits = { min: 200, max: 640, default: 250 };

/** What must be left for the content between the two sidebars. */
const CONTENT_FLOOR = 240;

/**
 * A width that fits both the sidebar's own limits and the window.
 *
 * `available` is the width of the flex row the sidebar sits in. Without that
 * term a stored width from a maximised window would swallow a narrow one
 * whole -- and since the width is persisted, the panel would come back
 * unusable with no obvious way to fix it.
 */
export function clampWidth(px: number, limits: SidebarLimits, available?: number): number {
	if (!Number.isFinite(px)) {
		return limits.default;
	}
	const ceiling = available !== undefined && available > 0
		? Math.min(limits.max, Math.max(limits.min, available - CONTENT_FLOOR))
		: limits.max;
	return Math.round(Math.min(Math.max(px, limits.min), ceiling));
}
