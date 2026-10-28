import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, test, vi } from "vitest";
import type { Db } from "#/db/client";
import * as schema from "#/db/schema";
import { createProduct, createTestDb } from "#/test/db";
import { saveCostReport } from "./charges";
import { committedOrder } from "./committed-order.fixtures";
import {
	findReturnable,
	listReturns,
	markNoReturn,
	restoreNoReturn,
} from "./returns-due";

// The order_returns_due view (drizzle/0082_returns_due_unmatched.sql) and the Returns
// tab's reads.

let db: Db;
let shopify: number;
let wrench: number;

beforeEach(async () => {
	db = await createTestDb();
	[{ id: shopify }] = await db
		.insert(schema.stores)
		.values({ channel: "shopify", name: "Shopify" })
		.returning();
	wrench = await createProduct(db, "WRENCH", "simple");
});

async function order(
	name: string,
	opts: {
		quantity?: number;
		tookStock?: boolean;
		extra?: Partial<typeof schema.orders.$inferInsert>;
	} = {},
) {
	const [row] = await db
		.insert(schema.orders)
		.values({
			storeId: shopify,
			externalId: name,
			name,
			customerName: "Dana Smith",
			shipCity: "Fresno",
			placedAt: new Date(),
			fulfillmentStatus: "FULFILLED",
			total: 0,
			sourceUpdatedAt: new Date(),
			...opts.extra,
		})
		.returning();
	const [line] = await db
		.insert(schema.orderLines)
		.values({
			orderId: row.id,
			externalId: `${name}-0`,
			productId: wrench,
			sku: "WRENCH",
			title: "Wrench",
			quantity: opts.quantity ?? 2,
			unitPrice: 20,
			unitCost: 8,
			saleBatchId: opts.tookStock === false ? null : crypto.randomUUID(),
		})
		.returning();
	return { id: row.id, lineId: line.id };
}

const refund = (orderId: number, amount: number) =>
	saveCostReport(db, {
		orderId,
		billedBy: "shopify",
		settled: false,
		noLabel: true,
		charges: [{ kind: "refund", description: "Refund", amount }],
	});

async function request(
	o: { id: number; lineId: number },
	status: (typeof schema.returnRequests.$inferInsert)["status"],
	extra: Partial<typeof schema.returnRequests.$inferInsert> = {},
) {
	const [r] = await db
		.insert(schema.returnRequests)
		.values({
			orderId: o.id,
			billedBy: "shopify",
			externalId: crypto.randomUUID(),
			status,
			waitingOn:
				status === "closed" || status === "cancelled"
					? "nobody"
					: status === "delivered"
						? "us"
						: status === "requested"
							? "buyer"
							: "marketplace",
			rawStatus: status,
			requestedAt: new Date(),
			sourceUpdatedAt: new Date(),
			...extra,
		})
		.returning();
	await db
		.insert(schema.returnRequestLines)
		.values({ requestId: r.id, orderLineId: o.lineId, quantity: 1 });
	return r.id;
}

async function due() {
	const { due } = await listReturns(db);
	return due.map((o) => ({
		name: o.name,
		state: o.state,
		expected: o.lines.reduce((n, l) => n + l.expected, 0),
	}));
}

describe("order_returns_due", () => {
	test("a full refund is due back until it's received or marked nothing coming", async () => {
		const o = await order("#1");
		await refund(o.id, 40);
		expect(await due()).toEqual([
			{ name: "#1", state: "refunded", expected: 2 },
		]);

		await db
			.insert(schema.orderReturns)
			.values({ orderLineId: o.lineId, quantity: 1, restocked: false });
		expect(await due()).toEqual([
			{ name: "#1", state: "refunded", expected: 1 },
		]);

		// Nothing more is coming: it's off the list, and the other unit is a
		// cost now.
		const { previous } = await markNoReturn(db, o.id);
		expect(await due()).toEqual([]);
		const [p] = await db
			.select()
			.from(schema.orderProfit)
			.where(eq(schema.orderProfit.orderId, o.id));
		expect(p).toMatchObject({ cost: 16, awaitingReturn: false });

		await restoreNoReturn(db, o.id, previous);
		expect(await due()).toHaveLength(1);
	});

	test("a partial refund is a maybe, until anything comes back", async () => {
		const o = await order("#2");
		await refund(o.id, 10);
		expect(await due()).toEqual([{ name: "#2", state: "maybe", expected: 2 }]);
		await db
			.insert(schema.orderReturns)
			.values({ orderLineId: o.lineId, quantity: 1, restocked: false });
		expect(await due()).toEqual([]);
	});

	test("an open request is due; shipped or tracked, it's on its way", async () => {
		const a = await order("#3");
		await request(a, "requested");
		const b = await order("#4");
		await request(b, "requested", { trackingNumber: "1Z999" });
		const c = await order("#5");
		await request(c, "delivered");
		const d = await order("#6");
		await request(d, "cancelled");
		expect(await due()).toEqual([
			{ name: "#4", state: "on_its_way", expected: 1 },
			{ name: "#5", state: "on_its_way", expected: 1 },
			{ name: "#3", state: "requested", expected: 1 },
		]);
	});

	test("an item no line matched still puts its order on Returns", async () => {
		const o = await order("#8");
		const id = await request(o, "shipped");
		await db
			.update(schema.returnRequestLines)
			.set({ orderLineId: null, sku: "MYSTERY" })
			.where(eq(schema.returnRequestLines.requestId, id));
		const {
			due: [found],
		} = await listReturns(db);
		expect(found).toMatchObject({
			name: "#8",
			state: "on_its_way",
			unmatched: [{ sku: "MYSTERY", quantity: 1 }],
			lines: [{ id: o.lineId, left: 2, expected: 0 }],
		});

		// Everything came back: nothing left it could be.
		await db
			.insert(schema.orderReturns)
			.values({ orderLineId: o.lineId, quantity: 2, restocked: false });
		expect(await due()).toEqual([]);
	});

	test("nothing coming back ends requests opened before it, not after", async () => {
		const o = await order("#7");
		await request(o, "requested", {
			requestedAt: new Date(Date.now() - 60_000),
		});
		await markNoReturn(db, o.id);
		expect(await due()).toEqual([]);
		await request(o, "requested", {
			requestedAt: new Date(Date.now() + 60_000),
		});
		expect(await due()).toEqual([
			{ name: "#7", state: "requested", expected: 1 },
		]);
	});

	test("lines that never took stock, and old or FBA orders, aren't due", async () => {
		const never = await order("#8", { tookStock: false });
		await refund(never.id, 40);
		const old = await order("#9", {
			extra: { placedAt: new Date(Date.now() - 70 * 86_400_000) },
		});
		await refund(old.id, 10);
		const fba = await order("#10", { extra: { fulfilledByChannel: true } });
		await request(fba, "requested");
		expect(await due()).toEqual([]);
	});

	test("orders shipped before the store's cutover are still due", async () => {
		// Cutover cleared their sale batches, but the units left our shelf.
		await db
			.update(schema.stores)
			.set({ stockFrom: new Date(Date.now() + 60_000) })
			.where(eq(schema.stores.id, shopify));
		const asked = await order("#13", { tookStock: false });
		await request(asked, "shipped");
		const refunded = await order("#14", { tookStock: false });
		await refund(refunded.id, 40);
		expect(await due()).toEqual([
			{ name: "#13", state: "on_its_way", expected: 1 },
			{ name: "#14", state: "refunded", expected: 2 },
		]);
	});

	test("with committed stock, only units that shipped are due back", async () => {
		// Two of three shipped; a third shipped and was put back.
		const { orderId } = await committedOrder(db, { id: shopify, wrench }, 2);
		await refund(orderId, 70);
		expect(await due()).toEqual([
			{ name: "#1001", state: "refunded", expected: 2 },
		]);
	});

	test("with committed stock, a partial refund may bring back what shipped", async () => {
		const { orderId } = await committedOrder(db, { id: shopify, wrench }, 2);
		await refund(orderId, 20);
		expect(await due()).toEqual([
			{ name: "#1001", state: "maybe", expected: 2 },
		]);
	});

	test("a due order that can't take a return here says why", async () => {
		const o = await order("#11", {
			extra: { fulfillmentStatus: "PARTIALLY_FULFILLED" },
		});
		await request(o, "requested");
		const { due } = await listReturns(db);
		expect(due[0].blocker).toMatch(/remaining items ship/);
	});

	test("received lately lists what came back", async () => {
		const o = await order("#12");
		await db
			.insert(schema.orderReturns)
			.values({ orderLineId: o.lineId, quantity: 2, restocked: false });
		const { received } = await listReturns(db);
		expect(received).toMatchObject([
			{
				name: "#12",
				sku: "WRENCH",
				quantity: 2,
				restocked: false,
				confirmOn: null,
			},
		]);
	});

	test("a received return links to its marketplace until it closes there", async () => {
		vi.stubEnv("SHOPIFY_STORE_DOMAIN", "kata.myshopify.com");
		const o = await order("#13");
		const requestId = await request(o, "delivered");
		await db
			.insert(schema.orderReturns)
			.values({ orderLineId: o.lineId, quantity: 1, restocked: false });
		expect((await listReturns(db)).received[0].confirmOn).toEqual({
			channel: "shopify",
			name: "Shopify",
			url: "https://admin.shopify.com/store/kata/orders/%2313",
		});

		await db
			.update(schema.returnRequests)
			.set({ status: "closed", waitingOn: "nobody" })
			.where(eq(schema.returnRequests.id, requestId));
		expect((await listReturns(db)).received[0].confirmOn).toBeNull();
		vi.unstubAllEnvs();
	});
});

describe("findReturnable", () => {
	test("finds shipped orders by buyer, city, SKU or number, not due ones", async () => {
		await order("#100");
		const dueOne = await order("#101");
		await refund(dueOne.id, 40);
		await order("#102", { extra: { fulfillmentStatus: "UNFULFILLED" } });

		for (const q of ["dana", "fresno", "wrench", "#100"]) {
			expect((await findReturnable(db, q)).map((o) => o.name)).toEqual([
				"#100",
			]);
		}
		expect(await findReturnable(db, "da")).toEqual([]);
	});
});
