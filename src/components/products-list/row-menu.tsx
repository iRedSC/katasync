import { useNavigate } from "@tanstack/react-router";
import {
	ClipboardList,
	Copy,
	ExternalLink,
	FileText,
	PackagePlus,
	Truck,
} from "lucide-react";
import {
	ContextMenuContent,
	ContextMenuItem,
	ContextMenuSeparator,
} from "#/components/ui/context-menu";
import { copyText } from "#/lib/copy";
import { formatOrderQuantity } from "#/lib/format";
import type { ProductRow } from "#/server/catalog";

// What putting this product on a PO means right now. A tool set's supplier
// is the one most of its parts come from.
function orderAction(p: ProductRow) {
	if (p.draft)
		return {
			kind: "draft" as const,
			why: `Already on PO ${p.draft.purchaseOrderId}`,
		};
	if (!p.supplier)
		return { kind: "no supplier" as const, why: "Set a supplier first" };
	return { kind: "add" as const, why: "", supplier: p.supplier.name };
}

export function RowMenu({
	product: p,
	onOpen,
	onAddToPo,
	adding,
	onCount,
}: {
	product: ProductRow;
	onOpen: (p: ProductRow) => void;
	onAddToPo: (p: ProductRow) => void;
	adding: ReadonlySet<number>;
	onCount: (p: ProductRow) => void;
}) {
	const navigate = useNavigate();
	const action = orderAction(p);
	const url = `/products/${encodeURIComponent(p.sku)}`;

	return (
		<ContextMenuContent>
			<ContextMenuItem onSelect={() => onOpen(p)} shortcut="↵">
				<FileText />
				Open
			</ContextMenuItem>
			<ContextMenuItem onSelect={() => window.open(url, "_blank")}>
				<ExternalLink />
				Open in new tab
			</ContextMenuItem>
			{action && <ContextMenuSeparator />}
			{action?.kind === "add" && (
				<ContextMenuItem
					onSelect={() => onAddToPo(p)}
					disabled={adding.has(p.id)}
					shortcut={p.reorder ? "A" : undefined}
				>
					<PackagePlus />
					{p.reorder
						? `Add ${formatOrderQuantity(p.reorder)} to PO`
						: "Add to PO"}
				</ContextMenuItem>
			)}
			{action?.kind === "draft" && p.draft && (
				<ContextMenuItem
					onSelect={() =>
						navigate({
							to: "/purchasing/$id",
							params: { id: String(p.draft?.purchaseOrderId) },
						})
					}
				>
					<Truck />
					Open PO {p.draft.purchaseOrderId}
				</ContextMenuItem>
			)}
			{action?.kind === "no supplier" && (
				<ContextMenuItem onSelect={() => onOpen(p)}>
					<PackagePlus />
					Set a supplier to order it
				</ContextMenuItem>
			)}
			<ContextMenuItem onSelect={() => onCount(p)} shortcut="C">
				<ClipboardList />
				Count stock
			</ContextMenuItem>
			<ContextMenuSeparator />
			<ContextMenuItem onSelect={() => copyText(p.sku)}>
				<Copy />
				Copy SKU
			</ContextMenuItem>
		</ContextMenuContent>
	);
}
