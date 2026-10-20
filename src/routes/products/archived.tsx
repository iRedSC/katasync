import { createFileRoute, Link } from "@tanstack/react-router";
import { Archive } from "lucide-react";
import { toast } from "sonner";
import { Card, EmptyState, Page } from "#/components/page";
import { ProductImage, ProductName } from "#/components/product";
import { ListCard, ListSkeleton } from "#/components/skeleton";
import { Button } from "#/components/ui/button";
import { formatCount, formatDay } from "#/lib/format";
import { optimism, optimistic } from "#/lib/optimism";
import { listArchivedProducts, restoreArchivedProduct } from "#/server/catalog";

export const Route = createFileRoute("/products/archived")({
	loader: () => listArchivedProducts(),
	component: ArchivedProducts,
	pendingComponent: () => (
		<ListSkeleton title="Archived products">
			<ListCard picture />
		</ListSkeleton>
	),
});

type Archived = Awaited<ReturnType<typeof listArchivedProducts>>[number];

const archivedData = optimistic<Archived[]>("archived-products");

// Products no longer carried. Lists, pickers, reordering, counting, and
// listing matching leave them out; restoring one brings it all back.
function ArchivedProducts() {
	const loaded = Route.useLoaderData();
	const archived = archivedData.useData("all", loaded);

	async function restore(p: Archived) {
		const r = await optimism.change({
			label: `Restoring ${p.sku}`,
			patch: archivedData.patch("all", (list) =>
				list.filter((x) => x.id !== p.id),
			),
			send: () => restoreArchivedProduct({ data: { sku: p.sku } }),
		});
		if (r) toast.success(`${p.sku} is carried again`);
	}

	return (
		<Page title="Archived products" back={{ to: "/products" }}>
			<Card>
				{archived.length === 0 ? (
					<EmptyState icon={Archive} title="Nothing archived">
						Archive a product from its page once it's no longer carried.
					</EmptyState>
				) : (
					<ul className="divide-y">
						{archived.map((p) => (
							<li key={p.id} className="flex items-center gap-3 py-2">
								<ProductImage src={p.imageUrl} />
								<Link
									to="/products/$sku"
									params={{ sku: p.sku }}
									className="flex min-w-0 flex-1 flex-col"
								>
									<ProductName name={p.name} variantName={p.variantName} />
									<span className="text-sm text-muted-foreground">
										{p.sku} · archived {formatDay(new Date(p.archivedAt))}
										{p.onHand !== 0 && ` · ${formatCount(p.onHand)} on hand`}
									</span>
								</Link>
								<Button variant="outline" onClick={() => restore(p)}>
									Restore
								</Button>
							</li>
						))}
					</ul>
				)}
			</Card>
		</Page>
	);
}
