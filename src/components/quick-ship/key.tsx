import type { ReactNode } from "react";

export function Key({ children }: { children: ReactNode }) {
	return (
		<kbd className="rounded border border-b-2 bg-white px-1.5 py-0.5 font-sans text-xs font-semibold text-foreground">
			{children}
		</kbd>
	);
}
