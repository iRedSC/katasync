import type { ReactNode } from "react";
import { formatDay } from "#/lib/format";
import { cn } from "#/lib/utils";
import { isBackOrdered, isLate } from "#/purchasing/status";
import type { PurchaseOrderDetail } from "#/server/purchasing";
import { isUnsent } from "./po-data";

// Past its date with something due that isn't back-ordered.
function late(d: PurchaseOrderDetail) {
	const units = (l: PurchaseOrderDetail["lines"][number]) =>
		(l.quantity - Math.min(l.received, l.quantity)) * l.packSize;
	const short = d.lines.reduce((n, l) => n + units(l), 0);
	const backOrdered = d.lines
		.filter(isBackOrdered)
		.reduce((n, l) => n + units(l), 0);
	return isLate({
		...d.order,
		ordered: short,
		received: 0,
		backOrdered,
	});
}

export function Dates({ detail: d }: { detail: PurchaseOrderDetail }) {
	const po = d.order;
	const rows: [string, ReactNode][] = [["Created", formatDay(po.createdAt)]];
	if (po.sentAt)
		rows.push([
			"Sent",
			<span key="sent">
				{formatDay(po.sentAt)}
				{po.sentTo && (
					<span className="text-muted-foreground"> to {po.sentTo}</span>
				)}
			</span>,
		]);
	if (po.expectedAt && po.status === "sent")
		rows.push([
			"Expected",
			<span
				key="expected"
				className={cn(late(d) && "font-medium text-critical-text")}
			>
				{formatDay(po.expectedAt)}
			</span>,
		]);
	if (po.closedAt)
		rows.push([
			po.status === "cancelled" ? "Cancelled" : "Closed",
			formatDay(po.closedAt),
		]);
	if (isUnsent(po.status))
		rows.push([
			"Lead time",
			`${d.supplier.leadTimeDays} days, about ${formatDay(new Date(Date.now() + d.supplier.leadTimeDays * 86_400_000))}`,
		]);
	return (
		<dl className="grid grid-cols-[5.5rem_minmax(0,1fr)] gap-y-1">
			{rows.map(([label, value]) => (
				<div key={label} className="contents">
					<dt className="text-muted-foreground">{label}</dt>
					<dd className="min-w-0 truncate">{value}</dd>
				</div>
			))}
		</dl>
	);
}
