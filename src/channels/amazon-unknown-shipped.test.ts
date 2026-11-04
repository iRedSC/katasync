import { eq } from "drizzle-orm";
import { beforeEach, expect, test, vi } from "vitest";
import type { Db } from "#/db/client";
import * as schema from "#/db/schema";
import { ingestOrder } from "#/orders/ingest";
import { createTestDb } from "#/test/db";
import { syncAmazon } from "./amazon";
import { spApi } from "./amazon-api";
import { ensureStore } from "./stores";

// A partly shipped Amazon order saved without its shipped count, that Amazon
// hasn't changed since: the pass's own windows never list it again.

vi.mock("./amazon-api", () => ({
	MARKETPLACE_US: "ATVPDKIKX0DER",
	spApi: vi.fn(),
}));

const ID = "111-0000000-0000001";
const updated = "2026-10-05T12:00:00.000Z";
const amazonOrder = {
	AmazonOrderId: ID,
	PurchaseDate: "2026-10-05T10:00:00.000Z",
	LastUpdateDate: updated,
	OrderStatus: "PartiallyShipped",
	FulfillmentChannel: "MFN",
};
const item = (shipped?: number) => ({
	OrderItemId: "item-1",
	Title: "Blade",
	QuantityOrdered: 3,
	...(shipped === undefined ? {} : { QuantityShipped: shipped }),
});

let db: Db;
let answer: (path: string) => unknown;
const asked: string[] = [];
beforeEach(async () => {
	db = await createTestDb();
	asked.length = 0;
	vi.mocked(spApi).mockImplementation(async (path: string) => {
		asked.push(path);
		return answer(path);
	});
	const store = await ensureStore(db, "amazon", {
		id: "amazon-us",
		name: "Amazon US",
	});
	await db
		.update(schema.stores)
		.set({ ordersSyncedThrough: new Date(Date.now() - 60 * 60 * 1000) })
		.where(eq(schema.stores.id, store.id));
	await ingestOrder(
		db,
		store,
		{
			externalId: ID,
			name: ID,
			salesChannel: "Amazon",
			marketplaceOrderId: `amazon:${ID}`,
			placedAt: new Date(amazonOrder.PurchaseDate),
			cancelledAt: null,
			fulfillmentStatus: "PARTIALLY_FULFILLED",
			fulfilledByChannel: false,
			soldInStore: false,
			financialStatus: "PAID",
			customerName: null,
			buyerId: null,
			shipAddress1: null,
			shipAddress2: null,
			shipCity: null,
			shipRegion: null,
			shipPostalCode: null,
			shipCountry: null,
			shipPhone: null,
			total: 30,
			shippingCharged: 0,
			tax: { remittedBy: "marketplace", lines: [] },
			sourceUpdatedAt: new Date(updated),
			lines: [
				{
					externalId: "item-1",
					listingExternalId: null,
					sku: null,
					title: "Blade",
					quantity: 3,
					shipped: null,
					unitPrice: 10,
				},
			],
		},
		{ shipping: null, store: null, pos: null, storeKeeps: 0 },
	);
});

const listing = (path: string) =>
	path.startsWith("/orders/v0/orders?") ? { payload: { Orders: [] } } : null;

async function shipped() {
	const rows = await db
		.select({ shipped: schema.orderLines.shippedQuantity })
		.from(schema.orderLines);
	return rows.map((r) => r.shipped);
}

test("it's read again by id, at the same revision, and its count saved", async () => {
	answer = (path) =>
		listing(path) ??
		(path.endsWith("/orderItems")
			? { payload: { OrderItems: [item(1)] } }
			: { payload: amazonOrder });
	const result = await syncAmazon(db, { listings: null });
	expect(asked).toContain(`/orders/v0/orders/${ID}`);
	expect(result.problems).toEqual([]);
	expect(await shipped()).toEqual([1]);
});

test("Amazon failing to answer for it is reported, and the pass finishes", async () => {
	answer = (path) => {
		const page = listing(path);
		if (page) return page;
		throw new Error("Amazon answered 503");
	};
	const result = await syncAmazon(db, { listings: null });
	expect(result.problems).toEqual([
		`${ID}: couldn't be read again for what shipped (Amazon answered 503)`,
	]);
	expect(await shipped()).toEqual([null]);
});
