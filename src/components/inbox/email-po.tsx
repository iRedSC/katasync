import { Link } from "@tanstack/react-router";
import { FileText } from "lucide-react";
import { useEffect, useState } from "react";
import { Badge } from "#/components/page";
import { formatCount, formatMoney } from "#/lib/format";
import { purchaseOrderStatus } from "#/purchasing/status";
import { getPoSummary, type PoSummary } from "#/server/purchasing";

// Above a supplier's email: the PO it's filed on, as the purchasing list
// shows it, one click from opening it. Asked as the email opens; until then,
// the number and supplier it already knows.
export function EmailPo({
	po,
	supplier,
}: {
	po: number;
	supplier: string | null;
}) {
	const [summary, setSummary] = useState<PoSummary | null>(null);
	useEffect(() => {
		let current = true;
		setSummary(null);
		getPoSummary({ data: { id: po } })
			.then((s) => current && setSummary(s))
			.catch(() => current && setSummary(null));
		return () => {
			current = false;
		};
	}, [po]);
	const status = summary && purchaseOrderStatus(summary);
	return (
		<Link
			to="/purchasing/$id"
			params={{ id: String(po) }}
			className="flex min-w-0 items-center gap-2 rounded-lg border px-3 py-2 text-sm hover:bg-surface"
		>
			<FileText className="size-4 shrink-0 text-muted-foreground" />
			<span className="shrink-0 font-semibold tabular-nums">PO {po}</span>
			{supplier && (
				<span className="truncate text-muted-foreground">{supplier}</span>
			)}
			{status && (
				<span className="animate-in fade-in-0">
					<Badge tone={status.tone}>{status.label}</Badge>
				</span>
			)}
			{summary && (
				<span className="ml-auto shrink-0 text-muted-foreground tabular-nums animate-in fade-in-0">
					{formatCount(summary.lines)}{" "}
					{summary.lines === 1 ? "product" : "products"} ·{" "}
					{formatMoney(summary.total)}
				</span>
			)}
		</Link>
	);
}
