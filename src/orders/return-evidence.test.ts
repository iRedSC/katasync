import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { parseReturnsReport } from "#/channels/amazon-returns";
import type { Db } from "#/db/client";
import * as schema from "#/db/schema";
import { createProduct, createTestDb } from "#/test/db";
import { type ChannelReturn, saveReturns } from "./return-requests";

describe("saving a return's evidence", () => {
	let db: Db;
	let store: typeof schema.stores.$inferSelect;

	beforeEach(async () => {
		db = await createTestDb();
		[store] = await db
			.insert(schema.stores)
			.values({ channel: "amazon", name: "Amazon US" })
			.returning();
		const [o] = await db
			.insert(schema.orders)
			.values({
				storeId: store.id,
				externalId: "111-1",
				name: "111-1",
				placedAt: new Date(),
				fulfillmentStatus: "Shipped",
				total: 40,
				sourceUpdatedAt: new Date(),
			})
			.returning();
		await db.insert(schema.orderLines).values([
			{
				orderId: o.id,
				externalId: "OI-1",
				productId: await createProduct(db, "WRENCH", "simple"),
				sku: "WRENCH",
				title: "Wrench",
				quantity: 1,
				unitPrice: 20,
			},
			{
				orderId: o.id,
				externalId: "OI-2",
				productId: await createProduct(db, "PAN", "simple"),
				sku: "PAN",
				title: "Pan",
				quantity: 1,
				unitPrice: 20,
			},
		]);
	});

	const ret: ChannelReturn = {
		externalId: "RMA1",
		orderExternalId: "111-1",
		kind: "return",
		status: "delivered",
		waitingOn: "us",
		respondBy: null,
		escalation: "in_progress",
		amount: "15.75",
		currency: "USD",
		nextAction: null,
		caseRef: null,
		rawStatus: "Approved",
		reason: "DEFECTIVE",
		note: null,
		trackingNumber: null,
		carrier: null,
		requestedAt: new Date("2026-10-20T12:00:00Z"),
		evidence: {
			aToZClaim: true,
			safetClaim: {
				id: "ST-1",
				state: "Pending",
				reason: "Damaged",
				reimbursement: { amount: "20.00", currency: "USD" },
				createdAt: "2026-10-21T00:00:00.000Z",
			},
			resolution: "StandardRefund",
			inPolicy: false,
			returnType: "C-Returns",
			label: {
				type: "AmazonPrePaidLabel",
				cost: { amount: "8.50", currency: "USD" },
				paidBy: "Seller",
			},
			deliveredAt: new Date("2026-10-22T12:00:00Z"),
		},
		lines: [
			{
				lineExternalId: "OI-1",
				sku: "WRENCH",
				quantity: 1,
				reason: "DEFECTIVE",
				rawStatus: "Approved",
			},
			{
				lineExternalId: "OI-2",
				sku: "PAN",
				quantity: 1,
				reason: "UNWANTED_ITEM",
				rawStatus: "Approved",
			},
		],
	};

	test("is saved, and reads back as unchanged despite jsonb's key order", async () => {
		const transaction = vi.spyOn(db, "transaction");
		await saveReturns(db, store, [ret]);
		await saveReturns(db, store, [ret]);
		expect(transaction).toHaveBeenCalledTimes(1);
		const [saved] = await db.select().from(schema.returnRequests);
		expect(saved).toMatchObject({
			aToZClaim: true,
			safetClaim: ret.evidence?.safetClaim,
			inPolicy: false,
			label: ret.evidence?.label,
			deliveredAt: ret.evidence?.deliveredAt,
			amount: "15.75",
			escalation: "in_progress",
		});
	});

	test("each item's reason reaches order_line_returns", async () => {
		await saveReturns(db, store, [ret]);
		const lines = await db
			.select({
				sku: schema.orderLines.sku,
				reasons: schema.orderLineReturns.reasons,
			})
			.from(schema.orderLineReturns)
			.innerJoin(
				schema.orderLines,
				eq(schema.orderLines.id, schema.orderLineReturns.lineId),
			)
			.orderBy(schema.orderLines.sku);
		expect(lines).toEqual([
			{ sku: "PAN", reasons: ["UNWANTED_ITEM"] },
			{ sku: "WRENCH", reasons: ["DEFECTIVE"] },
		]);
	});

	test("a marketplace that says none of it saves none of it", async () => {
		const { evidence: _, ...plain } = ret;
		await saveReturns(db, store, [plain]);
		const [saved] = await db.select().from(schema.returnRequests);
		expect(saved).toMatchObject({
			aToZClaim: null,
			safetClaim: null,
			label: null,
			deliveredAt: null,
		});
	});

	test("an older report without the evidence columns keeps what a full one saved", async () => {
		const full = [
			"Order ID\tReturn request date\tReturn request status\tAmazon RMA ID\tLabel type\tLabel cost\tCurrency code\tReturn carrier\tTracking ID\tLabel to be paid by\tA-to-Z Claim\tMerchant SKU\tReturn quantity\tReturn Reason\tIn policy\tReturn type\tResolution\tReturn delivery date\tSafeT Action reason\tSafeT claim id\tSafeT claim state\tSafeT claim creation time\tSafeT claim reimbursement amount\tRefunded Amount\tOrder Item ID",
			"111-1\t2026-10-20T12:00:00Z\tApproved\tRMA1\tAmazonPrePaidLabel\t8.50\tUSD\t\t\tSeller\tY\tWRENCH\t1\tDEFECTIVE\tN\tC-Returns\tStandardRefund\t2026-10-22T12:00:00Z\tDamaged\tST-1\tPending\t2026-10-21T00:00:00Z\t20.00\t15.75\tOI-1",
		].join("\n");
		const older = [
			"Order ID\tReturn request date\tReturn request status\tAmazon RMA ID\tTracking ID\tReturn carrier\tMerchant SKU\tReturn quantity\tReturn Reason\tReturn delivery date\tOrder Item ID",
			"111-1\t2026-10-20T12:00:00Z\tApproved\tRMA1\t\t\tWRENCH\t1\tDEFECTIVE\t2026-10-22T12:00:00Z\tOI-1",
		].join("\n");
		await saveReturns(db, store, parseReturnsReport(full).returns);
		const [before] = await db.select().from(schema.returnRequests);
		await saveReturns(db, store, parseReturnsReport(older).returns);
		const [after] = await db.select().from(schema.returnRequests);
		const kept = {
			aToZClaim: true,
			escalation: "in_progress",
			safetClaim: {
				id: "ST-1",
				state: "Pending",
				reason: "Damaged",
				reimbursement: { amount: "20.00", currency: "USD" },
				createdAt: "2026-10-21T00:00:00.000Z",
			},
			inPolicy: false,
			resolution: "StandardRefund",
			returnType: "C-Returns",
			label: {
				type: "AmazonPrePaidLabel",
				cost: { amount: "8.50", currency: "USD" },
				paidBy: "Seller",
			},
			amount: "15.75",
			currency: "USD",
		};
		expect(before).toMatchObject(kept);
		expect(after).toMatchObject(kept);
	});

	test("a full report's blank cells do clear what was saved", async () => {
		await saveReturns(db, store, [ret]);
		await saveReturns(db, store, [
			{
				...ret,
				escalation: null,
				amount: null,
				currency: null,
				evidence: { ...ret.evidence, aToZClaim: false, safetClaim: null },
			},
		]);
		const [saved] = await db.select().from(schema.returnRequests);
		expect(saved).toMatchObject({
			aToZClaim: false,
			safetClaim: null,
			escalation: null,
			amount: null,
		});
	});
});
