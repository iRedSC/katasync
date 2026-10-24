import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { Card } from "#/components/page";
import { cancelWithUndo } from "#/components/po-cancel";
import { Button } from "#/components/ui/button";
import { DateInput } from "#/components/ui/calendar";
import { cn } from "#/lib/utils";
import { cancelledOnList } from "#/purchasing/list-patches";
import {
	closePurchaseOrder,
	type PurchaseOrderDetail,
} from "#/server/purchasing";
import { today, utcDay } from "./days";
import { isUnsent } from "./po-data";
import type { useAction } from "./use-action";

// The rarer moves, kept out of the header.
export function OtherActions({
	detail: d,
	received,
	onSent,
	busy,
	run,
}: {
	detail: PurchaseOrderDetail;
	received: number;
	// With the day it went out, when that was before today.
	onSent: (sentOn?: string) => void;
	busy: boolean;
	run: ReturnType<typeof useAction>["run"];
}) {
	const navigate = useNavigate();
	const [sentOn, setSentOn] = useState(today);
	const po = d.order;
	if (po.status === "closed" || po.status === "cancelled") return null;
	const live = po.status;
	// Not ahead of today, and not before the PO was made, as the server
	// requires. Made late in the evening it can be tomorrow in UTC.
	const latest = today();
	const earliest = [utcDay(po.createdAt), latest].sort()[0];
	const sentOnValid = sentOn >= earliest && sentOn <= latest;
	return (
		<Card title="More">
			<div className="flex flex-col items-start gap-1">
				{isUnsent(po.status) && (
					<div className="flex items-center gap-1">
						<Button
							variant="ghost"
							size="sm"
							disabled={busy || d.lines.length === 0 || !sentOnValid}
							onClick={() => onSent(sentOn === latest ? undefined : sentOn)}
						>
							Mark as sent
						</Button>
						<DateInput
							aria-label="Sent on"
							value={sentOn}
							min={earliest}
							max={latest}
							disabled={busy}
							onChange={setSentOn}
							invalid={!sentOnValid}
							className={cn(
								"text-xs",
								sentOn === latest && "text-muted-foreground",
							)}
						/>
					</div>
				)}
				{po.status === "sent" && received > 0 && (
					<Button
						variant="ghost"
						size="sm"
						disabled={busy}
						onClick={() =>
							confirm("Stop waiting for the rest of this PO?") &&
							run(
								() => closePurchaseOrder({ data: { id: po.id } }),
								() => `PO ${po.id} closed`,
							)
						}
					>
						Close, the rest isn't coming
					</Button>
				)}
				{/* A suggested PO isn't saved, so there's nothing to delete. */}
				{received === 0 && live !== "suggested" && (
					<Button
						variant="ghost"
						size="sm"
						disabled={busy}
						className="text-critical-text"
						onClick={() => {
							// To the list first: it shows the PO gone or cancelled at
							// once, and a deleted draft's page has nothing to reload.
							navigate({ to: "/purchasing" });
							cancelWithUndo(
								{ id: po.id, status: live, supplierName: d.supplier.name },
								undefined,
								{ change: cancelledOnList(po.id) },
							);
						}}
					>
						{po.status === "draft" ? "Delete draft" : "Cancel PO"}
					</Button>
				)}
			</div>
		</Card>
	);
}
