import { describe, expect, test } from "vitest";
import { type Decision, refundStep } from "./refund-step";

const triagedAt = new Date("2026-10-28T12:00:00Z");
const later = new Date("2026-10-28T13:00:00Z");

const decision = (d: Partial<Decision>): Decision => ({
	id: 1,
	decision: "full",
	amount: null,
	note: null,
	refundedBefore: 0,
	decidedAt: later,
	settledAt: null,
	...d,
});

describe("refundStep", () => {
	test("checked in and never decided is ours to decide", () => {
		expect(
			refundStep({ triagedAt, decision: null, refundedNow: 0, itemValue: 20 }),
		).toEqual({
			kind: "decide",
		});
	});

	test("another box checked in after the decision asks again", () => {
		const d = decision({ decidedAt: new Date("2026-10-27T00:00:00Z") });
		expect(
			refundStep({ triagedAt, decision: d, refundedNow: 0, itemValue: 20 })
				.kind,
		).toBe("decide");
	});

	test("a refund waits until the charges show more refunded", () => {
		const d = decision({ refundedBefore: 0 });
		expect(
			refundStep({ triagedAt, decision: d, refundedNow: 0, itemValue: 20 }),
		).toEqual({
			kind: "send",
			decision: d,
		});
		expect(
			refundStep({ triagedAt, decision: d, refundedNow: 50, itemValue: 20 }),
		).toEqual({
			kind: "done",
			decision: d,
			how: "seen",
		});
	});

	test("a full refund already made is done when decided", () => {
		const d = decision({ refundedBefore: 99.99 });
		expect(
			refundStep({
				triagedAt,
				decision: d,
				refundedNow: 99.99,
				itemValue: 99.99,
			}),
		).toEqual({
			kind: "done",
			decision: d,
			how: "already",
		});
	});

	test("a refund of less than the items (shipping) isn't a full refund", () => {
		const d = decision({ refundedBefore: 5 });
		expect(
			refundStep({ triagedAt, decision: d, refundedNow: 5, itemValue: 100 })
				.kind,
		).toBe("send");
	});

	test("a partial refund is done already only if as much was refunded", () => {
		const short = decision({
			decision: "partial",
			amount: 40,
			refundedBefore: 10,
		});
		expect(
			refundStep({ triagedAt, decision: short, refundedNow: 10, itemValue: 20 })
				.kind,
		).toBe("send");
		const enough = { ...short, refundedBefore: 40 };
		expect(
			refundStep({
				triagedAt,
				decision: enough,
				refundedNow: 40,
				itemValue: 20,
			}),
		).toMatchObject({ kind: "done", how: "already" });
	});

	test("said by hand to be refunded is done", () => {
		const d = decision({ settledAt: later });
		expect(
			refundStep({ triagedAt, decision: d, refundedNow: 0, itemValue: 20 }),
		).toMatchObject({ kind: "done", how: "confirmed" });
	});

	test("no refund is done; something else stays until resolved", () => {
		expect(
			refundStep({
				triagedAt,
				decision: decision({ decision: "none" }),
				refundedNow: 0,
				itemValue: 20,
			}),
		).toMatchObject({ kind: "done", how: "refused" });
		const other = decision({ decision: "other", note: "File SAFE-T" });
		expect(
			refundStep({ triagedAt, decision: other, refundedNow: 0, itemValue: 20 })
				.kind,
		).toBe("flagged");
		expect(
			refundStep({
				triagedAt,
				decision: { ...other, settledAt: later },
				refundedNow: 0,
				itemValue: 20,
			}),
		).toMatchObject({ kind: "done", how: "resolved" });
	});
});
