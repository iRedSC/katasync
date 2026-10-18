import { CircleAlert } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "#/lib/utils";

export function Notice({
	tone,
	children,
}: {
	tone: "critical" | "info";
	children: ReactNode;
}) {
	return (
		<div
			className={cn(
				"flex items-start gap-3 rounded-xl border-2 px-5 py-4 text-lg",
				tone === "critical"
					? "border-critical-border bg-critical-surface text-critical-text"
					: "border-info-border bg-info-surface text-info-text",
			)}
		>
			<CircleAlert className="mt-0.5 size-6 shrink-0" />
			<span>{children}</span>
		</div>
	);
}
