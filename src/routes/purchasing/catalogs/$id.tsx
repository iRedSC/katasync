import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { Trash2 } from "lucide-react";
import { toast } from "sonner";
import { CatalogMark } from "#/components/catalog-mark";
import { AddProducts } from "#/components/catalogs/add-products";
import { CarriersCard } from "#/components/catalogs/carriers-card";
import { CatalogPhoto } from "#/components/catalogs/catalog-photo";
import {
	catalogData,
	cheapestItemCost,
	patchCatalog,
} from "#/components/catalogs/data";
import { PriceTable } from "#/components/catalogs/price-table";
import { Card, Page } from "#/components/page";
import { InlineField } from "#/components/purchase-order/inline-fields";
import { ListSkeleton } from "#/components/skeleton";
import { Button } from "#/components/ui/button";
import { Tip } from "#/components/ui/tooltip";
import { formatCount, formatDay, formatMoney } from "#/lib/format";
import { optimism } from "#/lib/optimism";
import { offerUndo } from "#/lib/undo";
import {
	deleteCatalog,
	describeCatalog,
	getCatalog,
	renameCatalog,
	restoreCatalog,
} from "#/server/purchasing";

export const Route = createFileRoute("/purchasing/catalogs/$id")({
	loader: ({ params }) => getCatalog({ data: { id: Number(params.id) } }),
	component: CatalogPage,
	pendingComponent: () => (
		<ListSkeleton title="Catalog" back={{ to: "/purchasing/catalogs" }} />
	),
});

// One catalog, laid out like a PO: its products down the page with every
// supplier's price across, and what it is and who sells it at the side.
function CatalogPage() {
	const loaded = Route.useLoaderData();
	const d = catalogData.useData(loaded.catalog.id, loaded);
	const navigate = useNavigate();
	const c = d.catalog;
	const stocked = d.products.filter((p) => p.onHand !== null);
	const worth = stocked.reduce((sum, p) => {
		const each = cheapestItemCost(p);
		return each === null ? sum : sum + Math.max(0, p.onHand ?? 0) * each;
	}, 0);
	const sold = d.products.reduce((sum, p) => sum + p.sold, 0);
	const unpriced = d.products.filter(
		(p) => p.kind !== "bundle" && !p.offers.some((o) => o.cost !== null),
	).length;

	async function remove() {
		const r = await optimism.change({
			send: () => deleteCatalog({ data: { id: c.id } }),
		});
		if (!r) return;
		navigate({ to: "/purchasing/catalogs" });
		offerUndo(`Deleted ${c.name}`, {
			undo: async () => {
				const back = await optimism.change({
					send: () => restoreCatalog({ data: r.value }),
				});
				if (!back) return null;
				navigate({
					to: "/purchasing/catalogs/$id",
					params: { id: String(back.value) },
				});
				return `Restored ${c.name}`;
			},
		});
	}

	return (
		<Page
			title={
				<span className="flex items-center gap-2">
					<CatalogMark catalog={c} />
					{c.name}
				</span>
			}
			back={{ to: "/purchasing/catalogs" }}
			width="wide"
			actions={
				<Tip
					content={
						d.products.length > 0
							? "Move its products out to delete it"
							: undefined
					}
				>
					<span>
						<Button
							variant="ghost"
							size="sm"
							disabled={d.products.length > 0}
							onClick={remove}
						>
							<Trash2 />
							Delete
						</Button>
					</span>
				</Tip>
			}
		>
			<div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_20rem]">
				<div className="flex min-w-0 flex-col gap-4">
					<div className="grid grid-cols-2 gap-3 md:grid-cols-4">
						<Stat label="Products" value={formatCount(d.products.length)} />
						<Stat
							label="Stock worth"
							value={formatMoney(worth)}
							tip="On hand at the cheapest supplier's price"
						/>
						<Stat
							label={`Sold, ${d.soldDays} days`}
							value={formatCount(sold)}
						/>
						<Stat
							label="No price"
							value={formatCount(unpriced)}
							tone={unpriced > 0 ? "warning" : undefined}
							tip="Products no supplier has priced, so reorder can't cost them"
						/>
					</div>
					<Card flush className="overflow-visible">
						<AddProducts catalog={c} />
						<PriceTable
							catalogId={c.id}
							carriers={d.carriers}
							products={d.products}
							soldDays={d.soldDays}
						/>
					</Card>
				</div>
				<div className="flex flex-col gap-4">
					<Card title="About">
						<div className="flex flex-col gap-3">
							<CatalogPhoto
								catalog={c}
								patch={(photoId) =>
									patchCatalog(c.id, (x) => ({
										...x,
										catalog: { ...x.catalog, photoId },
									}))
								}
							/>
							<InlineField
								shown={c.name}
								initial={c.name}
								placeholder="Name"
								label="Catalog name"
								className="-ml-1.5 w-full text-base font-semibold"
								onSave={async (name) => {
									if (name === "") {
										toast.error("A catalog needs a name");
										return false;
									}
									const r = await optimism.change({
										label: `Renaming ${c.name}`,
										patch: patchCatalog(c.id, (x) => ({
											...x,
											catalog: { ...x.catalog, name },
										})),
										send: () => renameCatalog({ data: { id: c.id, name } }),
									});
									return r !== null;
								}}
							/>
							<InlineField
								shown={c.description ?? ""}
								initial={c.description ?? ""}
								placeholder="Add a description, for search"
								label="Catalog description"
								className="-ml-1.5 w-full text-muted-foreground"
								onSave={async (text) => {
									const description = text === "" ? null : text;
									const r = await optimism.change({
										label: "Description",
										patch: patchCatalog(c.id, (x) => ({
											...x,
											catalog: { ...x.catalog, description },
										})),
										send: () =>
											describeCatalog({ data: { id: c.id, description } }),
									});
									return r !== null;
								}}
							/>
							<p className="text-xs text-faint">
								Made {formatDay(c.createdAt)}
							</p>
						</div>
					</Card>
					<CarriersCard
						catalog={c}
						carriers={d.carriers}
						products={d.products}
					/>
				</div>
			</div>
		</Page>
	);
}

function Stat({
	label,
	value,
	tip,
	tone,
}: {
	label: string;
	value: string;
	tip?: string;
	tone?: "warning";
}) {
	return (
		<Tip content={tip}>
			<div className="rounded-xl bg-card px-4 py-3 shadow-card">
				<div className="text-xs text-muted-foreground">{label}</div>
				<div
					className={
						tone === "warning"
							? "text-lg font-semibold text-warning-text tabular-nums"
							: "text-lg font-semibold tabular-nums"
					}
				>
					{value}
				</div>
			</div>
		</Tip>
	);
}
