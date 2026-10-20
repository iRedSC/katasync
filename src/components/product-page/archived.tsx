import { toast } from "sonner";
import { Badge } from "#/components/page";
import { Button } from "#/components/ui/button";
import { Tip } from "#/components/ui/tooltip";
import { optimism, optimistic } from "#/lib/optimism";
import { offerUndo } from "#/lib/undo";
import {
	archiveProductNow,
	type ProductDetail,
	restoreArchivedProduct,
} from "#/server/catalog";

// An archived product is reached by link (an order, a PO, the ledger) or
// Products > Archived, since lists and pickers leave it out; the page says so
// and brings it back.

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

// Archiving is refused while the product is still active; the refusal says
// what to settle first, and shows as the error.
export function ArchiveButton({
	productId,
	sku,
}: {
	productId: number;
	sku: string;
}) {
	const set = (archivedAt: Date | null) =>
		productData.patch(productId, (d) => ({
			...d,
			product: { ...d.product, archivedAt },
		}));
	async function archive() {
		const r = await optimism.change({
			label: `Archiving ${sku}`,
			patch: set(new Date()),
			send: () => archiveProductNow({ data: { sku } }),
		});
		if (!r) return;
		offerUndo(`${sku} archived`, {
			tone: "success",
			undo: async () => {
				const undone = await optimism.change({
					label: `Restoring ${sku}`,
					patch: set(null),
					send: () => restoreArchivedProduct({ data: { sku } }),
				});
				return undone && `${sku} is carried again`;
			},
		});
	}
	return (
		<Tip content="No longer carried: hide it from lists, reordering, counting, and matching, keeping its history">
			<Button variant="ghost" onClick={archive}>
				Archive
			</Button>
		</Tip>
	);
}
