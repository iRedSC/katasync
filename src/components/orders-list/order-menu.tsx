import { useNavigate } from "@tanstack/react-router";
import {
	AlertTriangle,
	Copy,
	ExternalLink,
	FileText,
	Link2,
	Printer,
} from "lucide-react";
import {
	ContextMenuContent,
	ContextMenuItem,
	ContextMenuSeparator,
} from "#/components/ui/context-menu";
import { copyText } from "#/lib/copy";
import { externalFulfillment } from "#/orders/fulfillment";
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
			{external && (
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
