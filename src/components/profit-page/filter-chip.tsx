import type { ReactNode } from "react";
import { cn } from "#/lib/utils";

export function Chip({
	on,
	onClick,
	children,
}: {
	on: boolean;
	onClick: () => void;
	children: ReactNode;
}) {
	return (
		<button
			type="button"
			aria-pressed={on}
			onClick={onClick}
			className={cn(
				"inline-flex h-8 items-center rounded-lg border px-2.5 font-medium",
				on
					? "border-ring bg-surface-strong text-foreground"
					: "text-muted-foreground hover:bg-surface hover:text-foreground",
			)}
		>
			{children}
		</button>
	);
}
