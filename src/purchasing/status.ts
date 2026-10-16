import type { Tone } from "#/components/page";

// One word for where a PO stands, worked out from its status and what has
// arrived. "Late" is a sent PO past its expected date.
export function purchaseOrderStatus(
	po: {
		status: "suggested" | "draft" | "sent" | "closed" | "cancelled";
		expectedAt: Date | string | null;
		ordered: number;
		received: number;
	},
	now = new Date(),
): { label: string; tone?: Tone } {
	switch (po.status) {
		case "suggested":
			return { label: "Suggested", tone: "success" };
		case "draft":
			return { label: "Draft", tone: "info" };
		case "cancelled":
			return { label: "Cancelled" };
		case "closed":
			return po.received >= po.ordered
				? { label: "Received", tone: "success" }
				: { label: "Closed short" };
		case "sent":
			if (po.expectedAt && new Date(po.expectedAt) < now)
				return { label: "Late", tone: "critical" };
			return po.received > 0
				? { label: "Partly received", tone: "warning" }
				: { label: "On order" };
	}
}
