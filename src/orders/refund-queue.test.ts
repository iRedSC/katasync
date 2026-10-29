import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, test } from "vitest";
import type { Db } from "#/db/client";
import { repairs, repairTools } from "#/db/repair-schema";
import * as schema from "#/db/schema";
import { createProduct, createTestDb } from "#/test/db";
import { saveCostReport } from "./charges";
import {
	decideRefund,
	listRefundQueue,
	settleRefund,
	undoRefundDecision,
} from "./refund-queue";
import { refundStep } from "./refund-step";
import { scanReturn } from "./return-scan";

// The Refunds view's reads and decisions, and finding a return by its label.

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

async function order(name: string) {
	const [row] = await db
		.insert(schema.orders)
		.values({
			storeId: shopify,
			externalId: name,
			name,
			customerName: "Dana Smith",
			placedAt: new Date(),
			fulfillmentStatus: "FULFILLED",
			total: 0,
			sourceUpdatedAt: new Date(),
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
			quantity: 2,
			unitPrice: 20,
			unitCost: 8,
			saleBatchId: crypto.randomUUID(),
		})
		.returning();
	return { id: row.id, lineId: line.id };
}

const checkIn = (lineId: number, note: string | null = null) =>
	db
		.insert(schema.orderReturns)
		.values({ orderLineId: lineId, quantity: 1, restocked: false, note });

const refund = (orderId: number, amount: number) =>
	saveCostReport(db, {
		orderId,
		billedBy: "shopify",
		settled: false,
		noLabel: true,
		charges: [{ kind: "refund", description: "Refund", amount }],
	});

const steps = async () =>
	(await listRefundQueue(db)).map((r) => ({
		name: r.name,
		step: refundStep(r).kind,
	}));

describe("listRefundQueue", () => {
	test("a checked-in return waits for a decision, with what was seen", async () => {
		const o = await order("#1");
		await checkIn(o.lineId, "Missing its blade");
		const [row] = await listRefundQueue(db);
		expect(row).toMatchObject({
			name: "#1",
			itemValue: 20,
			refundedNow: 0,
			decision: null,
			items: [{ outcome: "written_off", note: "Missing its blade" }],
		});
		expect(refundStep(row).kind).toBe("decide");
	});

	test("a refund decided waits until the charges show it", async () => {
		const o = await order("#2");
		await checkIn(o.lineId);
		await decideRefund(db, {
			orderId: o.id,
			decision: "full",
			amount: null,
			note: null,
			after: null,
		});
		expect(await steps()).toEqual([{ name: "#2", step: "send" }]);
		await refund(o.id, 20);
		expect(await steps()).toEqual([{ name: "#2", step: "done" }]);
	});

	test("an undecided return never ages out", async () => {
		const o = await order("#7");
		await db.insert(schema.orderReturns).values({
			orderLineId: o.lineId,
			quantity: 1,
			restocked: false,
			createdAt: new Date(Date.now() - 400 * 86_400_000),
		});
		expect(await steps()).toEqual([{ name: "#7", step: "decide" }]);
	});

	test("listing a benched unit as a refurb keeps its decision and note", async () => {
		const o = await order("#8");
		const benchedAt = new Date(Date.now() - 3 * 86_400_000);
		const refurb = await createProduct(db, "WRENCH-R1", "simple");
		await db
			.update(schema.products)
			.set({ refurbishedFromId: wrench, condition: "good" })
			.where(eq(schema.products.id, refurb));
		const [job] = await db
			.insert(repairs)
			.values({
				kind: "bench",
				status: "received",
				productId: wrench,
				returnLineId: o.lineId,
				createdAt: benchedAt,
			})
			.returning({ id: repairs.id });
		await db.insert(repairTools).values({
			repairId: job.id,
			tool: "Wrench",
			productId: wrench,
			problem: "Wrong item",
		});
		await decideRefund(db, {
			orderId: o.id,
			decision: "none",
			amount: null,
			note: null,
			after: null,
		});
		// Listed later: the job is refurbished and its unit received.
		await db
			.update(repairs)
			.set({ status: "refurbished", refurbProductId: refurb });
		const listed = {
			orderLineId: o.lineId,
			quantity: 1,
			restocked: false,
			refurbProductId: refurb,
		};
		const [back] = await db
			.insert(schema.orderReturns)
			.values({ ...listed, batchId: crypto.randomUUID(), benchId: job.id })
			.returning();
		const [row] = await listRefundQueue(db);
		expect(row.items).toMatchObject([
			{ outcome: "refurbished", note: "Wrong item", at: benchedAt },
		]);
		expect(refundStep(row).kind).toBe("done");

		// Undone and checked in again into the same refurb: a new check-in.
		await db
			.delete(schema.orderReturns)
			.where(eq(schema.orderReturns.id, back.id));
		await db
			.insert(schema.orderReturns)
			.values({ ...listed, batchId: crypto.randomUUID() });
		const [again] = await listRefundQueue(db);
		expect(again.items).toMatchObject([{ note: null }]);
		expect(refundStep(again).kind).toBe("decide");
	});

	test("pre-cutover returns never ask", async () => {
		const o = await order("#3");
		await db.insert(schema.orderReturns).values({
			orderLineId: o.lineId,
			quantity: 1,
			restocked: false,
			preCutover: true,
		});
		expect(await listRefundQueue(db)).toEqual([]);
	});
});

describe("decideRefund", () => {
	test("a stale decision is turned away; undo brings the last one back", async () => {
		const o = await order("#4");
		await checkIn(o.lineId);
		const first = await decideRefund(db, {
			orderId: o.id,
			decision: "other",
			amount: null,
			note: "Ask for photos",
			after: null,
		});
		await expect(
			decideRefund(db, {
				orderId: o.id,
				decision: "full",
				amount: null,
				note: null,
				after: null,
			}),
		).rejects.toThrow(/Someone else/);
		expect(await steps()).toEqual([{ name: "#4", step: "flagged" }]);
		await settleRefund(db, first.id, true);
		expect(await steps()).toEqual([{ name: "#4", step: "done" }]);
		await undoRefundDecision(db, first.id);
		expect(await steps()).toEqual([{ name: "#4", step: "decide" }]);
	});

	test("partial needs an amount and other needs a note", async () => {
		const o = await order("#5");
		const base = { orderId: o.id, after: null };
		await expect(
			decideRefund(db, {
				...base,
				decision: "partial",
				amount: null,
				note: null,
			}),
		).rejects.toThrow(/how much/);
		await expect(
			decideRefund(db, { ...base, decision: "other", amount: null, note: " " }),
		).rejects.toThrow(/what needs doing/);
	});
});

describe("scanReturn", () => {
	test("a label whose barcode ends with the tracking number finds its order", async () => {
		const o = await order("#6");
		await db.insert(schema.returnRequests).values({
			orderId: o.id,
			billedBy: "shopify",
			externalId: "r6",
			status: "shipped",
			waitingOn: "marketplace",
			rawStatus: "OPEN",
			trackingNumber: "9405 5112 0620 8312 3456 78",
			requestedAt: new Date(),
			sourceUpdatedAt: new Date(),
		});
		const usps = "42033101" + "9405511206208312345678";
		expect((await scanReturn(db, usps)).map((r) => r.name)).toEqual(["#6"]);
		expect((await scanReturn(db, "#6")).map((r) => r.name)).toEqual(["#6"]);
		expect(await scanReturn(db, "1Z999AA10123456784")).toEqual([]);
	});

	test("an Amazon order number scans with its dashes", async () => {
		await order("112-8353513-8788247");
		expect(
			(await scanReturn(db, "112-8353513-8788247")).map((r) => r.name),
		).toEqual(["112-8353513-8788247"]);
	});
});
