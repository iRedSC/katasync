import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, test } from "vitest";
import type { Db } from "#/db/client";
import * as schema from "#/db/schema";
import { recordCount } from "#/inventory/ledger";
import { type ProfitFixture, profitFixture } from "#/orders/profit.fixtures";
import { createProduct } from "#/test/db";
import {
	bestListing,
	listingState,
	type MarketDetail,
	marketAnalytics,
} from "./analytics";

let db: Db;
let amazon: number;
let wrench: number;
let order: ProfitFixture["order"];

const day = 86_400_000;
const now = Date.now();
const range = {
	start: new Date(now - 30 * day),
	end: new Date(now + day),
	previousStart: new Date(now - 60 * day),
	previousEnd: new Date(now - 30 * day),
};
const at = (daysAgo: number) => new Date(now - daysAgo * day);

beforeEach(async () => {
	({ db, amazon, wrench, order } = await profitFixture());
});

async function listing(
	storeId: number,
	productId: number,
	extra: Partial<typeof schema.listings.$inferInsert> = {},
) {
	await db.insert(schema.listings).values({
		storeId,
		productId,
		externalId: `${storeId}-${productId}-${Math.random()}`,
		title: "listing",
		...extra,
	});
}

async function stock(productId: number, counted: number) {
	let [warehouse] = await db
		.select()
		.from(schema.locations)
		.where(eq(schema.locations.name, "Warehouse"));
	warehouse ??= (
		await db
			.insert(schema.locations)
			.values({ name: "Warehouse", kind: "owned" })
			.returning()
	)[0];
	await recordCount(db, {
		productId,
		locationId: warehouse.id,
		counted,
		note: "test",
	});
}

const market = (all: MarketDetail[], m: string) => {
	const found = all.find((x) => x.market === m);
	if (!found) throw new Error(`no ${m}`);
	return found;
};

describe("markets", () => {
	test("best sellers, what sells elsewhere, and what loses money", async () => {
		const [{ id: shopify }] = await db
			.select({ id: schema.stores.id })
			.from(schema.stores)
			.where(eq(schema.stores.channel, "shopify"));
		const hammer = await createProduct(db, "HAMMER", "simple");
		// Wrench: sells on Shopify, listed on both; 2 before, 4 now.
		await listing(shopify, wrench);
		await listing(amazon, wrench);
		await order("#w1", [{ unitPrice: 20, quantity: 4, unitCost: 5 }], {
			placedAt: at(3),
		});
		await order("#w0", [{ unitPrice: 20, quantity: 2, unitCost: 5 }], {
			placedAt: at(40),
		});
		await stock(hammer, 5);
		// Hammer: sells on Amazon at a loss, never listed on Shopify.
		await listing(amazon, hammer);
		await order(
			"#h1",
			[{ unitPrice: 10, quantity: 1, unitCost: 30, productId: hammer }],
			{ storeId: amazon, marketplaceOrderId: "amazon:h1", placedAt: at(2) },
		);

		const all = await marketAnalytics(db, range);
		expect(all.map((m) => m.market)).toEqual(["shopify", "amazon"]);

		const s = market(all, "shopify");
		expect(s.best).toMatchObject([
			{ sku: "WRENCH", units: 4, unitsBefore: 2, revenue: 80 },
		]);
		expect(s.best[0].listing).toEqual({ kind: "live", problem: null });
		expect(s.unlisted).toMatchObject([
			{
				sku: "HAMMER",
				units: 1,
				soldOn: ["amazon"],
				listing: { kind: "none" },
			},
		]);
		expect(s.share).toBeCloseTo(80 / 90);

		const a = market(all, "amazon");
		expect(a.losing).toMatchObject([{ sku: "HAMMER", marginElsewhere: null }]);
		expect(a.losing[0].profit).toBeLessThan(0);
		// The wrench is listed on Amazon, so it isn't a listing to add.
		expect(a.unlisted).toEqual([]);
		// Out of stock, the wrench isn't suggested anywhere it isn't listed.
		expect(all.flatMap((m) => m.unlisted.map((u) => u.sku))).not.toContain(
			"WRENCH",
		);
	});

	test("a listing that ended after selling here is one to fix", async () => {
		await listing(amazon, wrench, { goneAt: at(1) });
		await order("#a", [{ unitPrice: 20, quantity: 1, unitCost: 5 }], {
			storeId: amazon,
			marketplaceOrderId: "amazon:a",
			placedAt: at(35),
		});
		// Out of stock, it ended for want of stock: nothing to fix here.
		expect(market(await marketAnalytics(db, range), "amazon").toFix).toEqual(
			[],
		);
		await stock(wrench, 3);
		const a = market(await marketAnalytics(db, range), "amazon");
		expect(a.toFix).toMatchObject([
			{ sku: "WRENCH", listing: { kind: "ended" }, revenue: 20 },
		]);
		expect(a.counts.toFix).toBe(1);
		// It sold 1 before and none now: below the bar for slipping.
		expect(a.slipping).toEqual([]);
	});

	test("a product selling half as much here as before is slipping", async () => {
		await order("#s0", [{ unitPrice: 20, quantity: 6, unitCost: 5 }], {
			placedAt: at(40),
		});
		await order("#s1", [{ unitPrice: 20, quantity: 3, unitCost: 5 }], {
			placedAt: at(4),
		});
		const s = market(await marketAnalytics(db, range), "shopify");
		expect(s.slipping).toMatchObject([
			{ sku: "WRENCH", units: 3, unitsBefore: 6, listing: { kind: "none" } },
		]);
	});
});

describe("listing state", () => {
	const live = {
		status: "ACTIVE",
		goneAt: null,
		fulfillment: "merchant" as const,
		stockPush: null,
	};

	test("ended, draft, and live problems", () => {
		expect(listingState({ ...live, status: "ARCHIVED" })).toEqual({
			kind: "ended",
		});
		expect(listingState({ ...live, status: "DRAFT" })).toEqual({
			kind: "draft",
		});
		expect(
			listingState({
				...live,
				stockPush: { state: "ready", target: {}, shows: 0, error: null },
			}),
		).toEqual({ kind: "live", problem: { kind: "shows_zero" } });
		// Amazon's own stock isn't ours to push.
		expect(
			listingState({
				...live,
				fulfillment: "fba",
				stockPush: { state: "ready", target: {}, shows: 0, error: null },
			}),
		).toEqual({ kind: "live", problem: null });
	});

	test("the best listing wins, and showing 0 only matters with stock", () => {
		const zero = {
			kind: "live" as const,
			problem: { kind: "shows_zero" as const },
		};
		expect(bestListing([{ kind: "ended" }, zero], 5)).toEqual(zero);
		expect(bestListing([zero], 0)).toEqual({ kind: "live", problem: null });
		expect(bestListing([zero, { kind: "live", problem: null }], 5)).toEqual({
			kind: "live",
			problem: null,
		});
		expect(bestListing([], 5)).toEqual({ kind: "none" });
	});
});
