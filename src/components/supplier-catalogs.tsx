import { Link } from "@tanstack/react-router";
import { X } from "lucide-react";
import { useEffect, useState } from "react";
import { CatalogMark } from "#/components/catalog-mark";
import { CatalogSelect } from "#/components/catalog-picker";
import { formatCount } from "#/lib/format";
import { optimism } from "#/lib/optimism";
import { offerUndo } from "#/lib/undo";
import {
	type CatalogRow,
	listCatalogs,
	makeCatalog,
	setSupplierCarries,
} from "#/server/purchasing";

type Catalog = { id: number; name: string };

// The catalogs a supplier carries, as chips: it sells everything in them.
// Each chip opens its catalog. Changes save at once, each with Undo; the
// supplier's terms for a catalog's products are kept when it stops carrying
// it, so carrying it again brings them back.
export function SupplierCatalogs({
	supplier,
	initial,
}: {
	supplier: { id: number; name: string };
	// Every catalog, when the page has them already.
	initial?: CatalogRow[];
}) {
	const [all, setAll] = useState<CatalogRow[] | null>(initial ?? null);
	useEffect(() => {
		if (!initial) listCatalogs().then(setAll);
	}, [initial]);
	const carries = (c: CatalogRow) =>
		c.suppliers.some((s) => s.id === supplier.id);
	const carried = all?.filter(carries) ?? [];

	// Shown at once; put back if the server refuses.
	function mark(catalog: Catalog, on: boolean) {
		setAll((list) => {
			const rest = (list ?? []).filter((c) => c.id !== catalog.id);
			const had = list?.find((c) => c.id === catalog.id);
			const base: CatalogRow = had ?? {
				...catalog,
				description: null,
				photoId: null,
				products: 0,
				suppliers: [],
			};
			const suppliers = on
				? [...base.suppliers, { id: supplier.id, name: supplier.name }]
				: base.suppliers.filter((s) => s.id !== supplier.id);
			return [...rest, { ...base, suppliers }].sort((a, b) =>
				a.name.localeCompare(b.name),
			);
		});
	}

	async function set(catalog: Catalog, on: boolean) {
		mark(catalog, on);
		const send = (carried: boolean) =>
			setSupplierCarries({
				data: { supplierId: supplier.id, catalogId: catalog.id, carried },
			});
		const r = await optimism.change({ send: () => send(on) });
		if (!r) return mark(catalog, !on);
		offerUndo(
			on
				? `${supplier.name} carries ${catalog.name}`
				: `${supplier.name} no longer carries ${catalog.name}`,
			{
				tone: "success",
				undo: async () => {
					mark(catalog, !on);
					const back = await optimism.change({ send: () => send(!on) });
					if (!back) {
						mark(catalog, on);
						return null;
					}
					return "Put back";
				},
			},
		);
	}

	async function make(name: string) {
		const r = await optimism.change({
			send: () => makeCatalog({ data: { name } }),
		});
		if (r) await set({ id: r.value, name }, true);
	}

	return (
		<div className="flex flex-wrap items-center gap-1.5">
			{all === null && <span className="text-muted-foreground">…</span>}
			{all !== null && carried.length === 0 && (
				<span className="text-muted-foreground">
					Carries no catalog, so it sells nothing yet.
				</span>
			)}
			{carried.map((c) => (
				<span
					key={c.id}
					className="inline-flex items-center gap-1 rounded-lg bg-subtle py-0.5 pr-0.5 pl-0.5 text-sm animate-in fade-in zoom-in-95"
				>
					<Link
						to="/purchasing/catalogs/$id"
						params={{ id: String(c.id) }}
						className="inline-flex items-center gap-1.5 rounded-md pr-1 hover:underline"
					>
						<CatalogMark catalog={c} />
						{c.name}
						<span className="text-xs text-muted-foreground tabular-nums">
							{formatCount(c.products)}
						</span>
					</Link>
					<button
						type="button"
						aria-label={`Stop carrying ${c.name}`}
						onClick={() => set(c, false)}
						className="rounded p-0.5 text-muted-foreground hover:bg-surface-strong hover:text-foreground"
					>
						<X className="size-3" />
					</button>
				</span>
			))}
			{all !== null && (
				<CatalogSelect
					value={null}
					catalogs={all.filter((c) => !carries(c))}
					onPick={(c) => c && set(c, true)}
					onMake={make}
					placeholder="Add catalog"
				/>
			)}
		</div>
	);
}
