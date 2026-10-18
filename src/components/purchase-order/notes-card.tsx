import { Card } from "#/components/page";
import { cn } from "#/lib/utils";
import { editDraft, type PurchaseOrderDetail } from "#/server/purchasing";
import { isUnsent, poData } from "./po-data";
import { useAction } from "./use-action";

export function NotesCard({ detail: d }: { detail: PurchaseOrderDetail }) {
	const po = d.order;
	const draft = isUnsent(po.status);
	const { save } = useAction();
	return (
		<Card title="Notes on this PO">
			{draft ? (
				<textarea
					defaultValue={po.notes ?? ""}
					placeholder="Printed on the PO"
					rows={3}
					onBlur={(e) => {
						const notes = e.target.value;
						if (notes === (po.notes ?? "")) return;
						save({
							label: "Notes on this PO",
							patch: poData.patch(po.id, (data) => ({
								...data,
								order: { ...data.order, notes },
							})),
							send: () =>
								editDraft({ data: { purchaseOrderId: po.id, notes } }),
						});
					}}
					className="w-full rounded-lg border border-input px-2 py-1.5 outline-none focus:border-ring"
				/>
			) : (
				<p className={cn(!po.notes && "text-muted-foreground")}>
					{po.notes ?? "None"}
				</p>
			)}
			{d.supplier.poNotes && (
				<p className="mt-2 text-muted-foreground">
					On every PO: {d.supplier.poNotes}
				</p>
			)}
		</Card>
	);
}
