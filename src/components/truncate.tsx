import { useState } from "react";
import { Tip } from "#/components/ui/tooltip";
import { cn } from "#/lib/utils";

// One line of text cut off with an ellipsis when it doesn't fit, and the
// whole of it on hover. Text that fits gets no tip, so hovering it stays
// quiet. Measured on hover, since the width depends on the screen.
// `children` styles the visible text when it isn't plain; `text` is still
// what the tip says.
export function Truncate({
	text,
	className,
	children,
}: {
	text: string;
	className?: string;
	children?: React.ReactNode;
}) {
	const [cut, setCut] = useState(false);
	return (
		<Tip content={cut ? text : null}>
			<span
				onPointerEnter={(e) =>
					setCut(e.currentTarget.scrollWidth > e.currentTarget.clientWidth)
				}
				className={cn("block min-w-0 truncate", className)}
			>
				{children ?? text}
			</span>
		</Tip>
	);
}
