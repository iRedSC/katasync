import { useNavigate } from "@tanstack/react-router";
import {
	AlertTriangle,
	BellRing,
	Copy,
	ExternalLink,
	FileText,
	HandHelping,
	Link2,
	PackageOpen,
	Printer,
	Send,
	Truck,
} from "lucide-react";
import {
	dropShip,
	packHere,
	shippedWithoutTracking,
} from "#/components/drop-ship";
import { pickedUp, readyForPickup } from "#/components/pickup";
import {
	ContextMenuContent,
	ContextMenuItem,
	ContextMenuSeparator,
} from "#/components/ui/context-menu";
import { copyText } from "#/lib/copy";
import { dropShipTarget } from "#/orders/drop-ship";
import { externalFulfillment } from "#/orders/fulfillment";
import { orderStatus } from "#/orders/status";
import type { OrderRow } from "#/server/orders";

// Only the actions this row's data supports. Shipping, returns, and voiding
// stay on the order's page: the review items just take you there.
export function OrderMenu({
	order: o,
	onMatch,
}: {
	order: OrderRow;
	onMatch: () => void;
}) {
	const navigate = useNavigate();
	const external = externalFulfillment(o);
	const status = orderStatus(o).key;
	const waiting = status === "dropship";

	return (
		<ContextMenuContent>
			<ContextMenuItem
				shortcut="↵"
				onSelect={() =>
					navigate({ to: "/orders/$id", params: { id: String(o.id) } })
				}
			>
				<FileText />
				Open
			</ContextMenuItem>
			<ContextMenuItem
				onSelect={() => window.open(`/orders/${o.id}`, "_blank")}
			>
				<ExternalLink />
				Open in new tab
			</ContextMenuItem>
			<ContextMenuItem
				onSelect={() => window.open(`/print/invoices?id=${o.id}`, "_blank")}
			>
				<Printer />
				Print invoice
			</ContextMenuItem>
			{o.pin !== null && !o.labelToVoid && (
				<ContextMenuItem onSelect={() => dropShip(o)}>
					<Truck />
					Drop-ship
				</ContextMenuItem>
			)}
			{status === "pickup" && (
				<ContextMenuItem onSelect={() => readyForPickup(o)}>
					<BellRing />
					Ready for pickup
				</ContextMenuItem>
			)}
			{(status === "pickup" || status === "ready") && (
				<ContextMenuItem onSelect={() => pickedUp(o)}>
					<HandHelping />
					Picked up
				</ContextMenuItem>
			)}
			{waiting && (
				<ContextMenuItem onSelect={() => packHere(o)}>
					<PackageOpen />
					Pack it here
				</ContextMenuItem>
			)}
			{waiting && dropShipTarget(o).kind === "tell" && (
				<ContextMenuItem onSelect={() => shippedWithoutTracking(o)}>
					<Send />
					Shipped, no tracking
				</ContextMenuItem>
			)}
			{external && !waiting && (
				<ContextMenuItem onSelect={() => window.open(external.url, "_blank")}>
					<ExternalLink />
					Fulfill on {external.name}
				</ContextMenuItem>
			)}
			{o.labelToVoid && (
				<ContextMenuItem
					onSelect={() =>
						navigate({ to: "/orders/$id", params: { id: String(o.id) } })
					}
				>
					<AlertTriangle />
					Review label to void
				</ContextMenuItem>
			)}
			{o.unmatched > 0 && (
				<ContextMenuItem onSelect={onMatch}>
					<Link2 />
					Match
				</ContextMenuItem>
			)}
			<ContextMenuSeparator />
			<ContextMenuItem onSelect={() => copyText(o.name)}>
				<Copy />
				Copy order name
			</ContextMenuItem>
		</ContextMenuContent>
	);
}
