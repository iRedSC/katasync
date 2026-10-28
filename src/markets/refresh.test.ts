import { beforeEach, describe, expect, test, vi } from "vitest";
import { shopifyQuery } from "#/channels/shopify";
import type { Db } from "#/db/client";
import { createTestDb } from "#/test/db";
import { checkStanding, readStanding, SHOPIFY_DISPUTE_PAGES } from "./refresh";

vi.mock("#/channels/shopify", () => ({ shopifyQuery: vi.fn() }));

let db: Db;

const order = (n: number) => ({
	name: `#${n}`,
	legacyResourceId: String(n),
	createdAt: "2026-10-01T00:00:00Z",
	totalPriceSet: { shopMoney: { amount: "10.00", currencyCode: "USD" } },
	disputes: [{ status: "NEEDS_RESPONSE", initiatedAs: "CHARGEBACK" }],
});

// Pages of orders for each search, by the cursor each is asked for with.
function shopifyAnswers(
	pages: (
		search: string,
		cursor: string | null,
	) => {
		nodes: ReturnType<typeof order>[];
		next: string | null;
	},
) {
	vi.mocked(shopifyQuery).mockImplementation(async (_query, variables) => {
		const { search, cursor } = variables as {
			search: string;
			cursor: string | null;
		};
		const { nodes, next } = pages(search, cursor);
		return {
			orders: {
				pageInfo: { hasNextPage: next !== null, endCursor: next },
				nodes,
			},
		};
	});
}

async function shopifyStanding() {
	await checkStanding(db, "shopify");
	const [row] = await readStanding(db);
	expect(row.error).toBeNull();
	if (!row.standing) throw new Error("No standing saved");
	return row.standing;
}

beforeEach(async () => {
	vi.clearAllMocks();
	db = await createTestDb();
});

describe("Shopify standing", () => {
	test("reads every page of disputes, not just the first", async () => {
		shopifyAnswers((search, cursor) =>
			search.includes("lost")
				? cursor === null
					? { nodes: [order(1), order(2)], next: "lost-2" }
					: { nodes: [order(3)], next: null }
				: cursor === null
					? { nodes: [order(4)], next: "open-2" }
					: { nodes: [order(5)], next: null },
		);
		const s = await shopifyStanding();
		expect(s.problems.map((p) => p.text)).toEqual([
			"Chargeback on #4 needs a response",
			"Chargeback on #5 needs a response",
		]);
		expect(s.metrics[0].value).toEqual({ kind: "count", count: 3 });
	});

	test("past the last page it reads, it says the counts are short", async () => {
		let n = 0;
		shopifyAnswers((search) =>
			search.includes("lost")
				? { nodes: [order(++n)], next: `lost-${n}` }
				: { nodes: [], next: null },
		);
		const s = await shopifyStanding();
		expect(s.metrics[0].value).toEqual({
			kind: "count",
			count: SHOPIFY_DISPUTE_PAGES,
		});
		expect(s.problems).toEqual([
			expect.objectContaining({
				level: "watch",
				text: expect.stringMatching(/^Over 1000 chargebacks lost/),
			}),
		]);
	});
});
