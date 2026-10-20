import { useRouter } from "@tanstack/react-router";
import {
	Copy,
	ExternalLink,
	FileText,
	NotebookPen,
	PackageCheck,
	Pencil,
	ShieldAlert,
	Trash2,
} from "lucide-react";
import {
	ContextMenuContent,
	ContextMenuItem,
	ContextMenuSeparator,
} from "#/components/ui/context-menu";
import { copyText } from "#/lib/copy";
import { formatCount } from "#/lib/format";
import type { PurchaseOrderDetail } from "#/server/purchasing";
import { receiveWithUndo, takeOff } from "./line-actions";
import { damageable } from "./line-damage";
import type { Line } from "./types";

// What a line can do from here. Price and unit stay on their own fields,
// which already open with a click.
export function LineMenu({
	line: l,
	detail: d,
	onEditQuantity,
	onReportDamage,
	onNote,
}: {
	line: Line;
	detail: PurchaseOrderDetail;
	onEditQuantity: () => void;
	onReportDamage: () => void;
	// null when the line's note can't change.
	onNote: (() => void) | null;
}) {
	const router = useRouter();
	const po = d.order;
	const url = `/products/${encodeURIComponent(l.sku)}`;
	const remaining = l.quantity - l.received;

	return (
		<ContextMenuContent>
			<ContextMenuItem
				onSelect={() =>
					router.navigate({ to: "/products/$sku", params: { sku: l.sku } })
				}
			>
				<FileText />
				Open product
			</ContextMenuItem>
			<ContextMenuItem onSelect={() => window.open(url, "_blank")}>
				<ExternalLink />
				Open product in new tab
			</ContextMenuItem>
			{po.status !== "cancelled" && (
				<>
					<ContextMenuSeparator />
					<ContextMenuItem onSelect={onEditQuantity} shortcut="Q">
						<Pencil />
						{po.status === "draft" ? "Change quantity" : "Amend quantity"}
					</ContextMenuItem>
				</>
			)}
			{po.status === "sent" && remaining > 0 && (
				<ContextMenuItem
					shortcut="R"
					onSelect={() => receiveWithUndo(l, remaining, po.id)}
				>
					<PackageCheck />
					Receive the rest ({formatCount(remaining)}
					{l.packSize === 1 ? "" : ` ${l.unit}`})
				</ContextMenuItem>
			)}
			{(po.status === "sent" || po.status === "closed") &&
				damageable(d, l) > 0 && (
					<ContextMenuItem shortcut="D" onSelect={onReportDamage}>
						<ShieldAlert />
						Arrived damaged…
					</ContextMenuItem>
				)}
			{onNote && (
				<ContextMenuItem shortcut="N" onSelect={onNote}>
					<NotebookPen />
					{l.receivingNote ? "Edit note…" : "Add note…"}
				</ContextMenuItem>
			)}
			{po.status === "draft" && (
				<ContextMenuItem
					className="text-critical-text [&_svg]:text-critical-text"
					onSelect={() => takeOff(l, po.id)}
				>
					<Trash2 />
					Take off this PO
				</ContextMenuItem>
			)}
			<ContextMenuSeparator />
			<ContextMenuItem onSelect={() => copyText(l.sku)}>
				<Copy />
				Copy SKU
			</ContextMenuItem>
		</ContextMenuContent>
	);
}
