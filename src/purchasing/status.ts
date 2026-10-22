import type { Tone } from "#/components/page";

// A line the supplier said is back-ordered, while some of it hasn't come.
// Once it's all in, being marked back-ordered no longer means anything.
export function isBackOrdered(line: {
	backOrderedAt: Date | string | null;
	quantity: number;
	received: number;
}) {
	return line.backOrderedAt !== null && line.received < line.quantity;
}

// One word for where a PO stands, worked out from its status and what has
// arrived. "Late" is a sent PO past its expected date with something still
// due that isn't back-ordered; back-ordered items come on no known day, so
// they can't be late. `backOrdered` is how many of what's short are, counted
// like `ordered`.
export function purchaseOrderStatus(
	po: {
		status: "suggested" | "draft" | "sent" | "closed" | "cancelled";
		expectedAt: Date | string | null;
		ordered: number;
		received: number;
		backOrdered: number;
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
		case "sent": {
			const due = po.ordered - po.received - po.backOrdered;
			if (due > 0 && po.expectedAt && new Date(po.expectedAt) < now)
				return { label: "Late", tone: "critical" };
			if (due <= 0 && po.backOrdered > 0)
				return { label: "Back-ordered", tone: "warning" };
			return po.received > 0
				? { label: "Partly received", tone: "warning" }
				: { label: "On order" };
		}
	}
}
