import { useRef, useState } from "react";
import { Card } from "#/components/page";
import { shake } from "#/components/shake";
import { cn } from "#/lib/utils";
import { editDraft, type PurchaseOrderDetail } from "#/server/purchasing";
import { isUnsent, poData } from "./po-data";
import { useAction } from "./use-action";

export function NotesCard({ detail: d }: { detail: PurchaseOrderDetail }) {
	const po = d.order;
	const draft = isUnsent(po.status);
	const { save } = useAction();
	const saved = po.notes ?? "";
	// The text follows the saved notes whenever they change, so a save that
	// fails puts back what was kept rather than what was typed.
	const [text, setText] = useState(saved);
	const [was, setWas] = useState(saved);
	if (was !== saved) {
		setWas(saved);
		setText(saved);
	}
	const field = useRef<HTMLTextAreaElement>(null);
	return (
		<Card title="Notes on this PO">
			{draft ? (
				<textarea
					ref={field}
					value={text}
					placeholder="Printed on the PO"
					rows={3}
					onChange={(e) => setText(e.target.value)}
					onBlur={async () => {
						if (text === saved) return;
						const r = await save({
							label: "Notes on this PO",
							patch: poData.patch(po.id, (data) => ({
								...data,
								order: { ...data.order, notes: text },
							})),
							send: () =>
								editDraft({ data: { purchaseOrderId: po.id, notes: text } }),
						});
						if (!r) shake(field.current);
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
