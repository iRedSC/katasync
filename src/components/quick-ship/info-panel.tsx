import type { ReactNode } from "react";
import { cn } from "#/lib/utils";

// Beside the steps: what's worth knowing about the choice in front of you,
// e.g. what the focused service's carrier re-billed before. Each section is
// one thing; the panel only shows when a step has something to say.
// Placed inside the dialog's scrolling body: on a wide screen it's lifted
// out past the dialog's right edge (positioned on the dialog itself, so the
// scroll doesn't clip it) and the steps never move; on a narrow one it
// follows them. 18rem plus its gap fits beside the 42rem dialog at 1280px.
export function InfoPanel({ children }: { children: ReactNode }) {
	return (
		<aside className="flex flex-col gap-5 border-t bg-subtle p-6 xl:absolute xl:top-0 xl:left-full xl:ml-3 xl:max-h-[calc(100dvh-2rem)] xl:w-72 xl:overflow-y-auto xl:rounded-lg xl:border xl:bg-card xl:shadow-lg xl:animate-in xl:fade-in xl:slide-in-from-left-2">
			{children}
		</aside>
	);
}

// Whole class names, so Tailwind finds them.
const toneText = {
	critical: "text-critical-text",
	warning: "text-warning-text",
} as const;

export function PanelSection({
	title,
	tone,
	children,
}: {
	title: ReactNode;
	tone?: keyof typeof toneText;
	children?: ReactNode;
}) {
	return (
		<section className="flex flex-col gap-2 animate-in fade-in duration-150">
			<h3
				className={cn(
					"font-semibold",
					tone ? toneText[tone] : "text-muted-foreground",
				)}
			>
				{title}
			</h3>
			{children}
		</section>
	);
}
