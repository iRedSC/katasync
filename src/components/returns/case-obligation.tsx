import { useEffect, useState } from "react";
import { Badge } from "#/components/page";
import { Tip } from "#/components/ui/tooltip";
import type { openCases } from "#/db/schema";
import { channelName } from "#/lib/format";

export type CaseObligationData = Pick<
	typeof openCases.$inferSelect,
	"status" | "waitingOn" | "respondBy" | "amount" | "currency" | "billedBy"
>;

export function deadlineChip(deadline: Date, now: number) {
	const remaining = deadline.getTime() - now;
	const hours = Math.ceil(Math.abs(remaining) / 3_600_000);
	return {
		tone:
			remaining < 12 * 3_600_000
				? ("critical" as const)
				: remaining < 48 * 3_600_000
					? ("warning" as const)
					: undefined,
		overdue: remaining < 0,
		label:
			remaining < 0
				? `${Math.abs(remaining) < 3_600_000 ? `${Math.ceil(-remaining / 60_000)}m` : `${hours}h`} overdue`
				: remaining < 3_600_000
					? `${Math.max(0, Math.ceil(remaining / 60_000))}m left`
					: `${hours}h left`,
	};
}

export function CaseObligation({ request }: { request: CaseObligationData }) {
	const [now, setNow] = useState(() => Date.now());
	const deadline = request.waitingOn === "us" ? request.respondBy : null;
	useEffect(() => {
		if (!deadline) return;
		const timer = setInterval(() => setNow(Date.now()), 30_000);
		return () => clearInterval(timer);
	}, [deadline]);
	const chip = deadline ? deadlineChip(deadline, now) : null;
	return (
		<span className="inline-flex flex-wrap items-center gap-1.5">
			{request.waitingOn === "us" && (
				<span
					role="img"
					className="size-1.5 rounded-full bg-amber-500"
					aria-label="Waiting on us"
				/>
			)}
			{request.status === "unknown" && (
				<Badge tone="warning">Unknown status</Badge>
			)}
			{chip && (
				<Tip content={deadline?.toLocaleString()}>
					<span
						className={chip.overdue ? "motion-safe:animate-pulse" : undefined}
					>
						<Badge tone={chip.tone}>{chip.label}</Badge>
					</span>
				</Tip>
			)}
			{request.waitingOn === "marketplace" && request.status !== "unknown" && (
				<span className="text-xs text-muted-foreground">
					{channelName(request.billedBy)} processing
				</span>
			)}
			{request.waitingOn === "buyer" && (
				<span className="text-xs text-muted-foreground">Waiting on buyer</span>
			)}
			{request.amount !== null && request.currency !== null && (
				<span className="text-sm font-medium tabular-nums">
					{new Intl.NumberFormat(undefined, {
						style: "currency",
						currency: request.currency,
					}).format(Number(request.amount))}
				</span>
			)}
		</span>
	);
}
