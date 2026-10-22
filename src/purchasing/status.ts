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

// A sent PO past its expected date with something still due that isn't
// back-ordered. Back-ordered items come on no known day, so they can't be
// late. `backOrdered` is how many of what's short are, counted like
// `ordered`.
export function isLate(
	po: {
		status: string;
		expectedAt: Date | string | null;
		ordered: number;
		received: number;
		backOrdered: number;
	},
	now = new Date(),
) {
	const due = po.ordered - po.received - po.backOrdered;
	return (
		po.status === "sent" &&
		due > 0 &&
		po.expectedAt !== null &&
		new Date(po.expectedAt) < now
	);
}

// One word for where a PO stands, worked out from its status, what has been
// received, and its tracked packages. "Arrived": every tracked package is
// delivered and nothing is received yet.
export function purchaseOrderStatus(po: {
	status: "suggested" | "draft" | "sent" | "closed" | "cancelled";
	ordered: number;
	received: number;
	packages: { arrived: number; total: number };
}): { label: string; tone?: Tone } {
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
			if (po.received > 0) return { label: "Receiving", tone: "warning" };
			if (po.packages.total > 0 && po.packages.arrived === po.packages.total)
				return { label: "Arrived", tone: "info" };
			return { label: "On order" };
	}
}

// A suggestion not yet on a draft: Order soon once enough essentials need it.
export const suggestionStatus = (
	readiness: "soon" | "ready",
): { label: string; tone: Tone } =>
	readiness === "soon"
		? { label: "Order soon", tone: "warning" }
		: { label: "Suggested", tone: "success" };
