import type { ReactNode } from "react";
import { formatDay } from "#/lib/format";
import type { PurchaseOrderDetail } from "#/server/purchasing";
import { isUnsent } from "./po-data";

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
		rows.push(["Expected", formatDay(po.expectedAt)]);
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
