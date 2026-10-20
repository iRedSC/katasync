import { toast } from "sonner";
import { Badge } from "#/components/page";
import { Button } from "#/components/ui/button";
import { Tip } from "#/components/ui/tooltip";
import { optimism, optimistic } from "#/lib/optimism";
import { type ProductDetail, restoreArchivedProduct } from "#/server/catalog";

// An archived product is reached only by link (an order, a PO, the ledger),
// since lists and pickers leave it out; the page says so and brings it back.

const productData = optimistic<ProductDetail>("product");

export function ArchivedBadge() {
	return (
		<Tip content="No longer carried: left out of product lists, pickers, reordering, counting, and listing matching. Its history stays.">
			<span>
				<Badge tone="warning">Archived</Badge>
			</span>
		</Tip>
	);
}

export function RestoreButton({
	productId,
	sku,
}: {
	productId: number;
	sku: string;
}) {
	return (
		<Button
			variant="outline"
			onClick={async () => {
				const r = await optimism.change({
					label: `Restoring ${sku}`,
					patch: productData.patch(productId, (d) => ({
						...d,
						product: { ...d.product, archivedAt: null },
					})),
					send: () => restoreArchivedProduct({ data: { sku } }),
				});
				if (r) toast.success(`${sku} is carried again`);
			}}
		>
			Restore
		</Button>
	);
}
