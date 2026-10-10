import { useRef } from "react";

const HOLD_MS = 450;
// A finger that drifts further than this is scrolling, not holding.
const SLOP_PX = 10;

// Keeps iOS from showing its callout and browsers from selecting the label
// while a button is held.
export const holdable =
	"touch-manipulation select-none [-webkit-touch-callout:none] [-webkit-user-select:none]";

// Tap vs. hold on one button. `onPress` runs on a normal tap, `onLongPress`
// after 450 ms without lifting. Spread the result onto the element and add
// the `holdable` classes.
export function useLongPress({
	onPress,
	onLongPress,
	disabled,
}: {
	onPress: () => void;
	onLongPress: () => void;
	disabled?: boolean;
}) {
	const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
	const start = useRef<{ x: number; y: number } | null>(null);

	const cancel = () => {
		clearTimeout(timer.current);
		start.current = null;
	};

	return {
		onPointerDown: (e: React.PointerEvent) => {
			if (disabled || e.button > 0) return;
			start.current = { x: e.clientX, y: e.clientY };
			timer.current = setTimeout(() => {
				start.current = null;
				navigator.vibrate?.(10);
				onLongPress();
			}, HOLD_MS);
		},
		onPointerMove: (e: React.PointerEvent) => {
			const from = start.current;
			if (!from) return;
			if (Math.hypot(e.clientX - from.x, e.clientY - from.y) > SLOP_PX)
				cancel();
		},
		onPointerUp: () => {
			const wasPending = start.current !== null;
			cancel();
			if (wasPending) onPress();
		},
		// Pointer events don't fire a click, so keyboards need their own path.
		onKeyDown: (e: React.KeyboardEvent) => {
			if (disabled || (e.key !== "Enter" && e.key !== " ")) return;
			e.preventDefault();
			onPress();
		},
		onPointerCancel: cancel,
		onPointerLeave: cancel,
		// Android opens a context menu on a long press.
		onContextMenu: (e: React.SyntheticEvent) => e.preventDefault(),
	};
}
