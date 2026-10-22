import { describe, expect, test } from "vitest";
import { isBackOrdered, purchaseOrderStatus } from "./status";

const now = new Date("2026-10-22T12:00:00Z");
const pastDue = new Date("2026-10-20T12:00:00Z");
const sent = (p: { received: number; backOrdered: number }) =>
	purchaseOrderStatus(
		{ status: "sent", expectedAt: pastDue, ordered: 10, ...p },
		now,
	).label;

describe("a sent PO past its date", () => {
	test("is late while something not back-ordered is still due", () => {
		expect(sent({ received: 0, backOrdered: 0 })).toBe("Late");
		expect(sent({ received: 4, backOrdered: 5 })).toBe("Late");
	});

	test("waiting only on back orders says so instead", () => {
		expect(sent({ received: 4, backOrdered: 6 })).toBe("Back-ordered");
		expect(sent({ received: 0, backOrdered: 10 })).toBe("Back-ordered");
	});
});

test("a line is back-ordered only while some of it hasn't come", () => {
	const at = new Date();
	expect(isBackOrdered({ backOrderedAt: at, quantity: 5, received: 2 })).toBe(
		true,
	);
	expect(isBackOrdered({ backOrderedAt: at, quantity: 5, received: 5 })).toBe(
		false,
	);
	expect(isBackOrdered({ backOrderedAt: null, quantity: 5, received: 0 })).toBe(
		false,
	);
});
