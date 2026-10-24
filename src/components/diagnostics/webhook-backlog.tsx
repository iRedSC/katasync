import { CircleCheck, Clock3, LoaderCircle, TriangleAlert } from "lucide-react";
import type { DiagnosticsOverview } from "#/diagnostics/overview";

export function WebhookBacklog({
	backlog,
}: {
	backlog: DiagnosticsOverview["webhooks"];
}) {
	const delayed = backlog.failing > 0 || (backlog.oldestAgeSeconds ?? 0) > 300;
	const Status = delayed
		? TriangleAlert
		: backlog.pending > 0
			? LoaderCircle
			: CircleCheck;
	return (
		<section
			aria-label="Order webhook backlog"
			className={`flex flex-wrap items-center gap-x-4 gap-y-2 rounded-lg border p-4 ${delayed ? "border-amber-500/40 bg-amber-500/5" : "border-border"}`}
		>
			<Status
				aria-hidden="true"
				className={`size-4 ${delayed ? "text-amber-500" : backlog.pending > 0 ? "animate-spin text-muted-foreground" : "text-emerald-500"}`}
			/>
			<output className="text-sm">
				{backlog.pending > 0
					? `${backlog.pending} order updates waiting`
					: "Order updates caught up"}
			</output>
			{backlog.pending > 0 && (
				<span className="flex items-center gap-1 text-xs text-muted-foreground">
					<Clock3 aria-hidden="true" className="size-3" />
					Oldest {Math.max(0, Math.floor((backlog.oldestAgeSeconds ?? 0) / 60))}
					m
				</span>
			)}
			{backlog.lastError && (
				<p className="basis-full break-words text-xs text-amber-500">
					{backlog.lastError.message}
				</p>
			)}
		</section>
	);
}
