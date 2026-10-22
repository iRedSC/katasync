import { describe, expect, test } from "vitest";
import { isBackOrdered, isLate, purchaseOrderStatus } from "./status";

const now = new Date("2026-10-22T12:00:00Z");
const pastDue = new Date("2026-10-20T12:00:00Z");
const late = (p: { received: number; backOrdered: number }) =>
	isLate({ status: "sent", expectedAt: pastDue, ordered: 10, ...p }, now);

describe("a sent PO past its date", () => {
	test("is late while something not back-ordered is still due", () => {
		expect(late({ received: 0, backOrdered: 0 })).toBe(true);
		expect(late({ received: 4, backOrdered: 5 })).toBe(true);
	});

	test("isn't late when it waits only on back orders", () => {
		expect(late({ received: 4, backOrdered: 6 })).toBe(false);
		expect(late({ received: 0, backOrdered: 10 })).toBe(false);
	});
});

describe("a sent PO", () => {
	const sent = (received: number, arrived: number, total: number) =>
		purchaseOrderStatus({
			status: "sent",
			ordered: 10,
			received,
			packages: { arrived, total },
		}).label;

	test("is on order until every tracked package is delivered", () => {
		expect(sent(0, 0, 0)).toBe("On order");
		expect(sent(0, 1, 2)).toBe("On order");
		expect(sent(0, 2, 2)).toBe("Arrived");
	});

	test("is receiving once anything is received", () => {
		expect(sent(3, 2, 2)).toBe("Receiving");
		expect(sent(3, 0, 0)).toBe("Receiving");
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
