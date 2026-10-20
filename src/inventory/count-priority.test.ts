import { describe, expect, test } from "vitest";
import { rankCounts, reasonOf, type Shelf } from "./count-priority";
import { TRUST_DAYS } from "./stock-state";

const now = new Date("2026-10-20T12:00:00Z");
const daysAgo = (n: number) => new Date(now.getTime() - n * 86_400_000);

function shelf(sku: string, extra: Partial<Shelf> = {}): Shelf {
	return {
		productId: 1,
		sku,
		name: sku,
		category: null,
		locationId: 1,
		location: "Warehouse",
		abc: "C",
		onHand: 5,
		lastCountedAt: daysAgo(5),
		countRequestedAt: null,
		misses: 0,
		...extra,
	};
}

describe("reasonOf", () => {
	test("a recent count with nothing asked is trusted", () => {
		expect(reasonOf(shelf("X"), now)).toBeNull();
		expect(
			reasonOf(shelf("X", { lastCountedAt: daysAgo(TRUST_DAYS) }), now),
		).toBeNull();
	});

	test("old or missing counts are stale", () => {
		for (const lastCountedAt of [daysAgo(TRUST_DAYS + 1), null])
			expect(reasonOf(shelf("X", { lastCountedAt }), now)).toBe("stale");
	});

	test("a request stays until a count lands after it", () => {
		expect(
			reasonOf(
				shelf("X", { lastCountedAt: daysAgo(3), countRequestedAt: daysAgo(2) }),
				now,
			),
		).toBe("requested");
		expect(
			reasonOf(
				shelf("X", { lastCountedAt: daysAgo(1), countRequestedAt: daysAgo(2) }),
				now,
			),
		).toBeNull();
	});

	test("below zero is oversold even right after a count", () => {
		expect(reasonOf(shelf("X", { onHand: -1 }), now)).toBe("oversold");
	});
});

describe("rankCounts", () => {
	test("orders by reason, class, misses, then the longest waiting", () => {
		const ranked = rankCounts(
			[
				shelf("trusted"),
				shelf("c-stale", { lastCountedAt: daysAgo(90) }),
				shelf("a-stale", { abc: "A", lastCountedAt: daysAgo(70) }),
				shelf("a-never", { abc: "A", lastCountedAt: null }),
				shelf("a-missing", {
					abc: "A",
					lastCountedAt: daysAgo(61),
					misses: 3,
				}),
				shelf("c-requested", { countRequestedAt: daysAgo(1) }),
				shelf("c-oversold", { onHand: -2 }),
				shelf("unclassed", { abc: null, lastCountedAt: daysAgo(400) }),
			],
			now,
		);
		expect(ranked.map((s) => s.sku)).toEqual([
			"c-oversold",
			"c-requested",
			"a-missing",
			"a-never",
			"a-stale",
			"unclassed",
			"c-stale",
		]);
	});
});
