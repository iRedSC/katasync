import { useNavigate } from "@tanstack/react-router";
import { Card } from "#/components/page";
import { cancelWithUndo } from "#/components/po-cancel";
import { Button } from "#/components/ui/button";
import { cancelledOnList } from "#/purchasing/list-patches";
import {
	closePurchaseOrder,
	type PurchaseOrderDetail,
} from "#/server/purchasing";
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
	onSent: () => void;
	busy: boolean;
	run: ReturnType<typeof useAction>["run"];
}) {
	const navigate = useNavigate();
	const po = d.order;
	if (po.status === "closed" || po.status === "cancelled") return null;
	const live = po.status;
	return (
		<Card title="More">
			<div className="flex flex-col items-start gap-1">
				{isUnsent(po.status) && (
					<Button
						variant="ghost"
						size="sm"
						disabled={busy || d.lines.length === 0}
						onClick={onSent}
					>
						Mark as sent
					</Button>
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
