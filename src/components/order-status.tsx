import { ExternalLink } from "lucide-react";
import { Badge } from "#/components/page";
import { Tip } from "#/components/ui/tooltip";
import type { OrderStatus } from "#/orders/status";

// An order's status as one badge. One shipped from the marketplace's page
// opens it, as the arrow says.
export function OrderStatusBadge({ status }: { status: OrderStatus }) {
	if (status.key !== "external")
		return <Badge tone={status.tone}>{status.label}</Badge>;
	return (
		<Tip content={`Fulfill on ${status.on}`}>
			<a
				href={status.url}
				target="_blank"
				rel="noreferrer"
				// Inside a row that opens the order: this opens the marketplace's.
				onClick={(e) => e.stopPropagation()}
				className="rounded-md hover:opacity-80"
			>
				<Badge tone={status.tone}>
					{status.label}
					<ExternalLink className="ml-1 size-3" />
				</Badge>
			</a>
		</Tip>
	);
}
