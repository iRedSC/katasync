import type { repairStatus } from "#/db/repair-schema";

// Where a repair can go from where it is. The board's four columns move
// freely. Picked up comes from Shopify when the draft order is paid; staff
// set it by hand only when there's nothing to charge, and can take that
// back. A paid repair is done for good. Cancelling takes the repair's
// charges off its draft order; restoring puts them back.

export type RepairStatus = (typeof repairStatus.enumValues)[number];

export const boardStatuses = [
	"received",
	"waiting_parts",
	"in_repair",
	"ready",
] as const satisfies readonly RepairStatus[];
export type BoardStatus = (typeof boardStatuses)[number];

export const statusNames: Record<RepairStatus, string> = {
	received: "Received",
	waiting_parts: "Waiting on parts",
	in_repair: "In repair",
	ready: "Ready",
	picked_up: "Picked up",
	cancelled: "Cancelled",
};

export const isOnBoard = (s: RepairStatus): s is BoardStatus =>
	(boardStatuses as readonly string[]).includes(s);

export type RepairState = {
	status: RepairStatus;
	// A draft order holds charges still to pay.
	hasDraft: boolean;
	// It was paid in Shopify, as this order.
	paid: boolean;
};

// Null when the move is allowed, else why not, in a few words.
export function refuseMove(from: RepairState, to: RepairStatus): string | null {
	if (from.status === to) return null;
	switch (from.status) {
		case "received":
		case "waiting_parts":
		case "in_repair":
		case "ready":
			if (isOnBoard(to) || to === "cancelled") return null;
			return from.hasDraft ? "Pay the draft order in Shopify first" : null;
		case "picked_up":
			if (from.paid) return "Already paid in Shopify";
			return isOnBoard(to) ? null : "Move it back to the board first";
		case "cancelled":
			return isOnBoard(to) ? null : "Restore it to the board first";
	}
}
