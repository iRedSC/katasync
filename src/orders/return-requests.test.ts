import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, test } from "vitest";
import type { Db } from "#/db/client";
import * as schema from "#/db/schema";
import { createProduct, createTestDb } from "#/test/db";
import { returnReasons } from "./return-reasons";
import {
	type ChannelReturn,
	matchLine,
	returnStage,
	saveReturns,
} from "./return-requests";

describe("matchLine", () => {
	const lines = [
		{ id: 1, externalId: "A", sku: "WRENCH" },
		{ id: 2, externalId: "B", sku: "HAWK" },
		{ id: 3, externalId: "C", sku: "HAWK" },
	];
	const item = (lineExternalId: string | null, sku: string | null) => ({
		lineExternalId,
		sku,
		quantity: 1,
	});
	test("by id, then a SKU only one line has, then the only line", () => {
		expect(matchLine(lines, item("B", "WRENCH"))).toBe(2);
		expect(matchLine(lines, item("Z", "WRENCH"))).toBe(1);
		// Two lines share the SKU: unclear, so none.
		expect(matchLine(lines, item("Z", "HAWK"))).toBeNull();
		expect(matchLine([lines[2]], item(null, null))).toBe(3);
		expect(
			matchLine(lines, {
				...item("forward-line", "HAWK"),
				alternateLineExternalId: "A",
			}),
		).toBe(1);
		expect(
			matchLine(lines, {
				...item("B", "WRENCH"),
				alternateLineExternalId: "A",
			}),
		).toBe(2);
	});
});

describe("saveReturns", () => {
	let db: Db;
	let store: typeof schema.stores.$inferSelect;
	let lineId: number;

	beforeEach(async () => {
		db = await createTestDb();
		[store] = await db
			.insert(schema.stores)
			.values({ channel: "amazon", name: "Amazon US" })
			.returning();
		const product = await createProduct(db, "WRENCH", "simple");
		const [o] = await db
			.insert(schema.orders)
			.values({
				storeId: store.id,
				externalId: "111-1",
				name: "111-1",
				placedAt: new Date(),
				fulfillmentStatus: "Shipped",
				total: 20,
				sourceUpdatedAt: new Date(),
			})
			.returning();
		[{ id: lineId }] = await db
			.insert(schema.orderLines)
			.values({
				orderId: o.id,
				externalId: "OI-1",
				productId: product,
				sku: "WRENCH",
				title: "Wrench",
				quantity: 1,
				unitPrice: 20,
			})
			.returning();
	});

	const amazonReturn = (status: "requested" | "closed"): ChannelReturn => ({
		externalId: "RMA1",
		orderExternalId: "111-1",
		rawStatus: status,
		...returnStage(status),
		amount: null,
		currency: null,
		nextAction: null,
		caseRef: null,
		reason: "DEFECTIVE",
		note: "Leaks from the bottom",
		trackingNumber: null,
		carrier: null,
		requestedAt: new Date(),
		lines: [{ lineExternalId: "OI-1", sku: "WRENCH", quantity: 1 }],
	});

	test("a TikTok return is found by its TikTok order id, wherever the order lives", async () => {
		const [tiktok] = await db
			.insert(schema.stores)
			.values({ channel: "tiktok", name: "TikTok" })
			.returning();
		const [o] = await db
			.insert(schema.orders)
			.values({
				storeId: tiktok.id,
				externalId: "577610389712769305",
				marketplaceOrderId: "tiktok:577610389712769305",
				name: "577610389712769305",
				placedAt: new Date(),
				fulfillmentStatus: "FULFILLED",
				total: 20,
				sourceUpdatedAt: new Date(),
			})
			.returning();
		const [line] = await db
			.insert(schema.orderLines)
			.values({
				orderId: o.id,
				externalId: "sku-1729",
				sku: "WRENCH",
				title: "Wrench",
				quantity: 1,
				unitPrice: 20,
			})
			.returning();
		const relayed: ChannelReturn = {
			...amazonReturn("requested"),
			externalId: "gid://shopify/Return/1",
			orderExternalId: "gid://shopify/Order/5544",
			marketplaceOrderId: "tiktok:577610389712769305",
			lines: [
				{
					lineExternalId: "gid://shopify/LineItem/1",
					sku: "WRENCH",
					quantity: 1,
				},
			],
		};
		expect(
			await saveReturns(db, { ...store, channel: "shopify" }, [relayed]),
		).toEqual({
			saved: 1,
			skipped: 0,
			missing: [],
		});
		const [saved] = await db.select().from(schema.returnRequestLines);
		expect(saved.orderLineId).toBe(line.id);
	});

	test("saves against the order's line, and a later report replaces it", async () => {
		const unknown = {
			...amazonReturn("requested"),
			externalId: "RMA2",
			orderExternalId: "999",
		};
		expect(
			await saveReturns(db, store, [amazonReturn("requested"), unknown]),
		).toEqual({
			saved: 1,
			skipped: 1,
			missing: ["999"],
		});
		await saveReturns(db, store, [amazonReturn("closed")]);

		const requests = await db.select().from(schema.returnRequests);
		expect(requests).toMatchObject([
			{
				billedBy: "amazon",
				status: "closed",
				reason: "DEFECTIVE",
				note: "Leaks from the bottom",
			},
		]);
		const lines = await db
			.select()
			.from(schema.returnRequestLines)
			.where(eq(schema.returnRequestLines.requestId, requests[0].id));
		expect(lines).toMatchObject([{ orderLineId: lineId, quantity: 1 }]);
	});

	test("a refund waits on us without being due back, and never ships", async () => {
		// The order went out before the store's cutover, so it left our shelf
		// and a return request would make it due.
		await db
			.update(schema.stores)
			.set({ stockFrom: new Date(Date.now() + 86_400_000) })
			.where(eq(schema.stores.id, store.id));
		await saveReturns(db, store, [
			{
				...amazonReturn("requested"),
				kind: "refund",
				status: "requested",
				waitingOn: "us",
				respondBy: null,
			},
		]);
		const [request] = await db.select().from(schema.returnRequests);
		expect(request).toMatchObject({ kind: "refund", status: "requested" });
		expect(await db.select().from(schema.orderReturnsDue)).toEqual([]);
		// The same request as a return is due.
		await db
			.update(schema.returnRequests)
			.set({ kind: "return" })
			.where(eq(schema.returnRequests.id, request.id));
		expect(await db.select().from(schema.orderReturnsDue)).toMatchObject([
			{ lineId, state: "requested", expected: 1 },
		]);
		await db
			.update(schema.returnRequests)
			.set({ kind: "refund" })
			.where(eq(schema.returnRequests.id, request.id));
		await expect(
			db
				.update(schema.returnRequests)
				.set({ status: "shipped" })
				.where(eq(schema.returnRequests.id, request.id)),
		).rejects.toThrow();
	});
});

describe("returnReasons", () => {
	test("one or two words a chip, the same reason alike across channels", () => {
		const chips = (raw: string) => returnReasons(raw).map((r) => r.chip);
		expect(chips("CR-SWITCHEROO; WRONG_ITEM; Wrong item")).toEqual([
			"Wrong item",
		]);
		expect(chips("No longer needed")).toEqual(["Unwanted"]);
		expect(chips("CR-SOME_REASON")).toEqual(["Some reason"]);
		expect(chips("CR-SOME_NEW_REASON")).toEqual(["Some new…"]);
		expect(chips("")).toEqual([]);
		for (const r of returnReasons(
			"AMZ-PG-BAD-DESC; CR-DAMAGED_BY_CARRIER; FOUND_BETTER_PRICE; CR-UNAUTHORIZED_PURCHASE; Wrong item was sent; Damaged or defective; Returned to sender; Item Arrived Late; Item doesn't match description; Product wouldn't arrive on time; Missing package; Damaged item or packaging; Item arrived too late; Missing items",
		))
			expect(r.chip.split(" ").length).toBeLessThanOrEqual(2);
	});
});
