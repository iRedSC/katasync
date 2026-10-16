import { optimistic, type Patch } from "#/lib/optimism";
import type { PurchasingList } from "#/server/purchasing";

// How changes to POs show on the PO list before the server has them. Here
// rather than in the list's route, so the PO page can move its PO on the
// list too.

type OrderRow = PurchasingList["open"][number];

// The list's data, with changes not yet confirmed laid over it.
export const purchasingData = optimistic<PurchasingList>("purchasing");

// The list shows this many of the latest finished POs, as listPurchasing does.
const DONE_LISTED = 30;

// Takes a PO off whichever list it's on.
export function withoutOrder(d: PurchasingList, id: number): PurchasingList {
	return {
		...d,
		open: d.open.filter((o) => o.id !== id),
		incoming: d.incoming.filter((o) => o.id !== id),
		done: d.done.filter((o) => o.id !== id),
	};
}

// Puts a PO on the list its status puts it on, newest first, as the server
// lists them.
export function withOrder(d: PurchasingList, order: OrderRow): PurchasingList {
	const rest = withoutOrder(d, order.id);
	const newestFirst = (list: OrderRow[]) =>
		[...list, order].sort((a, b) => b.id - a.id);
	switch (order.status) {
		case "draft":
			return { ...rest, open: newestFirst(rest.open) };
		case "sent":
			return { ...rest, incoming: newestFirst(rest.incoming) };
		case "closed":
		case "cancelled":
			return {
				...rest,
				done: newestFirst(rest.done).slice(0, DONE_LISTED),
			};
		default:
			// A suggested PO isn't listed.
			return rest;
	}
}

// A sent PO once cancelled. Its date is when it was cancelled, to the day.
export const cancelledRow = (o: OrderRow): OrderRow => ({
	...o,
	status: "cancelled",
	closedAt: new Date(),
});

// A PO deleted or cancelled from its own page, which has no list row to hand:
// the list finds it by id.
export const cancelledOnList = (id: number): Patch =>
	purchasingData.patch("all", (d) => {
		const row = [...d.open, ...d.incoming].find((o) => o.id === id);
		if (!row) return d;
		return row.status === "draft"
			? withoutOrder(d, id)
			: withOrder(d, cancelledRow(row));
	});
