import { createFileRoute } from "@tanstack/react-router";
import { Trash2 } from "lucide-react";
import { useState } from "react";
import { Badge, Card, Page } from "#/components/page";
import { InlineField } from "#/components/purchase-order/inline-fields";
import { ListSkeleton } from "#/components/skeleton";
import { SupplierDialog } from "#/components/supplier-dialog";
import { Tip } from "#/components/ui/tooltip";
import { formatCount, formatMoney } from "#/lib/format";
import { optimism, optimistic } from "#/lib/optimism";
import { MIN_MEASURED_POS } from "#/purchasing/forecast";
import {
	type CatalogRow,
	deleteCatalog,
	listCatalogs,
	listSuppliers,
	renameCatalog,
	type SupplierRow,
} from "#/server/purchasing";

export const Route = createFileRoute("/purchasing/suppliers")({
	loader: async () => {
		const [suppliers, catalogs] = await Promise.all([
			listSuppliers(),
			listCatalogs(),
		]);
		return { suppliers, catalogs };
	},
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
	const loaded = Route.useLoaderData();
	const rows = supplierRows.useData("all", loaded.suppliers);
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
										{/* Enter on the name opens it too: its click bubbles to the row. */}
										<button
											type="button"
											className="truncate rounded-sm font-medium text-left outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring"
										>
											{r.supplier.name}
										</button>
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
									<Tip
										content={
											r.leadTime.measured
												? `Measured from ${r.leadTime.measured.pos} POs (typed: ${r.leadTime.configured})`
												: `Typed in; measured after ${MIN_MEASURED_POS} received POs`
										}
									>
										<span>
											{r.leadTime.days} days
											{r.leadTime.measured && (
												<span className="ml-1 text-xs text-muted-foreground">
													measured
												</span>
											)}
										</span>
									</Tip>
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
			<CatalogsCard catalogs={loaded.catalogs} />
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
		</Page>
	);
}

const catalogRows = optimistic<CatalogRow[]>("catalogs");

// Every catalog, who carries it, and how many products it holds. Names
// change in place. An empty one can go; one with products says to move them,
// since deleting it would leave them bought from no one. Suppliers take
// catalogs on in their own dialog, products on their page.
function CatalogsCard({ catalogs: loaded }: { catalogs: CatalogRow[] }) {
	const catalogs = catalogRows.useData("all", loaded);
	if (catalogs.length === 0) return null;
	const patch = (fn: (all: CatalogRow[]) => CatalogRow[]) =>
		catalogRows.patch("all", fn);
	return (
		<Card flush title="Catalogs">
			<table className="w-full">
				<tbody>
					{catalogs.map((c) => (
						<tr key={c.id} className="group border-t first:border-t-0">
							<td className="w-full max-w-0 px-4 py-1.5">
								<InlineField
									shown={c.name}
									initial={c.name}
									placeholder="Name"
									label={`Rename ${c.name}`}
									className="w-full font-medium"
									onSave={async (name) => {
										const r = await optimism.change({
											label: `Renaming ${c.name}`,
											patch: patch((all) =>
												all.map((x) => (x.id === c.id ? { ...x, name } : x)),
											),
											send: () => renameCatalog({ data: { id: c.id, name } }),
										});
										return r !== null;
									}}
								/>
								<div className="truncate px-1.5 text-xs text-muted-foreground">
									{c.suppliers.length === 0
										? "Nobody carries it"
										: c.suppliers.map((s) => s.name).join(", ")}
								</div>
							</td>
							<td className="px-4 py-1.5 text-right whitespace-nowrap text-muted-foreground tabular-nums">
								{formatCount(c.products)}{" "}
								{c.products === 1 ? "product" : "products"}
							</td>
							<td className="py-1.5 pr-3">
								{c.products === 0 && (
									<button
										type="button"
										aria-label={`Delete ${c.name}`}
										onClick={() =>
											optimism.change({
												label: `Deleting ${c.name}`,
												patch: patch((all) => all.filter((x) => x.id !== c.id)),
												send: () => deleteCatalog({ data: { id: c.id } }),
											})
										}
										className="rounded p-1 text-muted-foreground opacity-0 group-hover:opacity-100 hover:bg-subtle hover:text-critical-text focus-visible:opacity-100"
									>
										<Trash2 className="size-4" />
									</button>
								)}
							</td>
						</tr>
					))}
				</tbody>
			</table>
		</Card>
	);
}
