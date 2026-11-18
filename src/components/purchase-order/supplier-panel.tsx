import { useState } from "react";
import { Card } from "#/components/page";
import { SupplierDialog } from "#/components/supplier-dialog";
import { Tip } from "#/components/ui/tooltip";
import { formatPhone } from "#/lib/format";
import type { PurchaseOrderDetail } from "#/server/purchasing";
import { poData } from "./po-data";

export function SupplierPanel({ detail: d }: { detail: PurchaseOrderDetail }) {
	const po = d.order;
	const [editingSupplier, setEditingSupplier] = useState(false);
	return (
		<>
			<Card
				title="Supplier"
				aside={
					<button
						type="button"
						onClick={() => setEditingSupplier(true)}
						className="text-link hover:underline"
					>
						Edit
					</button>
				}
			>
				<div className="flex flex-col gap-0.5">
					<span className="font-medium">{d.supplier.name}</span>
					{d.supplier.contacts.length > 0 ? (
						d.supplier.contacts.map((c) => (
							<Tip key={c.email} content={c.name && c.email}>
								<a
									href={`mailto:${c.email}`}
									className="truncate text-link hover:underline"
								>
									{c.name ?? c.email}
								</a>
							</Tip>
						))
					) : (
						<span className="text-muted-foreground">No contacts</span>
					)}
					{d.supplier.phone && <span>{formatPhone(d.supplier.phone)}</span>}
					{d.supplier.paymentTerms && (
						<span className="text-muted-foreground">
							Terms: {d.supplier.paymentTerms}
						</span>
					)}
					{d.supplier.notes && (
						<p className="mt-2 rounded-lg bg-subtle px-2 py-1.5">
							{d.supplier.notes}
						</p>
					)}
				</div>
			</Card>
			<SupplierDialog
				supplier={d.supplier}
				leadTime={d.leadTime}
				open={editingSupplier}
				onOpenChange={setEditingSupplier}
				patch={(supplier) =>
					poData.patch(po.id, (data) => ({ ...data, supplier }))
				}
			/>
		</>
	);
}
