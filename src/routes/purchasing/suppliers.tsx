import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { Badge, Card, Page } from "#/components/page";
import { ListSkeleton } from "#/components/skeleton";
import { SupplierDialog } from "#/components/supplier-dialog";
import { formatCount, formatMoney } from "#/lib/format";
import { optimistic } from "#/lib/optimism";
import { listSuppliers, type SupplierRow } from "#/server/purchasing";

export const Route = createFileRoute("/purchasing/suppliers")({
	loader: () => listSuppliers(),
	component: Suppliers,
	pendingComponent: () => (
		<ListSkeleton
			title="Suppliers"
			back={{ to: "/purchasing" }}
			width="narrow"
		/>
	),
});

// The suppliers' rows, with changes not yet confirmed laid over them.
const supplierRows = optimistic<SupplierRow[]>("suppliers");

function Suppliers() {
	const rows = supplierRows.useData("all", Route.useLoaderData());
	const [editing, setEditing] = useState<number | null>(null);
	const supplier = rows.find((r) => r.supplier.id === editing);

	return (
		<Page title="Suppliers" back={{ to: "/purchasing" }} width="narrow">
			<Card flush>
				<table className="w-full">
					<thead>
						<tr className="border-b bg-subtle text-left text-xs text-muted-foreground">
							<th className="px-4 py-2 font-medium">Supplier</th>
							<th className="hidden px-4 py-2 font-medium md:table-cell">
								Email
							</th>
							<th className="px-4 py-2 text-right font-medium">Products</th>
							<th className="px-4 py-2 text-right font-medium">Lead time</th>
							<th className="px-4 py-2 text-right font-medium">Threshold</th>
						</tr>
					</thead>
					<tbody>
						{rows.map((r) => (
							<tr
								key={r.supplier.id}
								onClick={() => setEditing(r.supplier.id)}
								className="cursor-pointer border-t first:border-t-0 hover:bg-subtle"
							>
								<td className="w-full max-w-0 px-4 py-2.5">
									<div className="flex items-center gap-2">
										<span className="truncate font-medium">
											{r.supplier.name}
										</span>
										{r.openOrders > 0 && <Badge>{r.openOrders} on order</Badge>}
									</div>
									<div className="text-xs text-muted-foreground">
										{r.supplier.code}
									</div>
								</td>
								<td className="hidden px-4 py-2.5 md:table-cell">
									{r.supplier.email ? (
										<span className="truncate">{r.supplier.email}</span>
									) : (
										<Badge tone="warning">No email</Badge>
									)}
								</td>
								<td className="px-4 py-2.5 text-right tabular-nums">
									{formatCount(r.products)}
								</td>
								<td className="px-4 py-2.5 text-right whitespace-nowrap tabular-nums">
									<span
										title={
											r.leadTime.measured
												? `Measured from the last ${r.leadTime.measured.pos} POs; typed in as ${r.leadTime.configured}`
												: "Typed in; measured once enough POs arrive"
										}
									>
										{r.leadTime.days} days
										{r.leadTime.measured && (
											<span className="ml-1 text-xs text-muted-foreground">
												measured
											</span>
										)}
									</span>
								</td>
								<td className="px-4 py-2.5 text-right tabular-nums">
									{r.supplier.minimumOrder > 0
										? formatMoney(r.supplier.minimumOrder)
										: "None"}
								</td>
							</tr>
						))}
					</tbody>
				</table>
			</Card>
			{supplier && (
				<SupplierDialog
					supplier={supplier.supplier}
					leadTime={supplier.leadTime}
					open
					onOpenChange={(open) => !open && setEditing(null)}
					patch={(saved) =>
						supplierRows.patch("all", (all) =>
							all.map((r) =>
								r.supplier.id !== saved.id
									? r
									: {
											...r,
											supplier: saved,
											// Reorder uses the measured lead time when there is one (see leadTimes).
											leadTime: {
												...r.leadTime,
												configured: saved.leadTimeDays,
												days: r.leadTime.measured?.days ?? saved.leadTimeDays,
											},
										},
							),
						)
					}
				/>
			)}
			<p className="px-1 text-muted-foreground">
				A product is reordered once its stock would run out within the lead time
				plus a safety margin, then bought to last the cover days on top. Lead
				times are measured from deliveries once a supplier has 3 received POs. A
				supplier's suggested PO is ready once its total reaches their spend
				threshold.
			</p>
		</Page>
	);
}
