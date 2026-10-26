import { readFileSync } from "node:fs";
import { eq, sql } from "drizzle-orm";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, expect, test, vi } from "vitest";
import { tiktokToReturn } from "#/channels/tiktok-returns";
import { CaseObligation } from "#/components/returns/case-obligation";
import { TooltipProvider } from "#/components/ui/tooltip";
import type { Db } from "#/db/client";
import { openCases, orders, returnRequests, stores } from "#/db/schema";
import { createTestDb } from "#/test/db";
import {
	type CaseMoney,
	importReturns,
	type RequestStage,
	saveReturns,
} from "./return-requests";
import { listReturns } from "./returns-due";

let db: Db;
let store: typeof stores.$inferSelect;
const request = (deadline = 1793037279) =>
	tiktokToReturn(
		{
			return_id: "4035352486720738032",
			order_id: "577620148777947888",
			return_status: "RETURN_OR_REFUND_REQUEST_PENDING",
			return_type: "REFUND",
			create_time: 1792000000,
			seller_next_action_response: [
				{ action: "SELLER_RESPOND_REFUND", deadline },
			],
			refund_amount: { refund_total: "101.77", currency: "USD" },
		},
		null,
		{ id: "4035352489823474416", status: "PENDING_REQUEST_REVIEW" },
	);

beforeEach(async () => {
	db = await createTestDb();
	[store] = await db
		.insert(stores)
		.values({ channel: "tiktok", name: "TikTok" })
		.returning();
	await db.insert(orders).values({
		storeId: store.id,
		externalId: "577620148777947888",
		name: "577620148777947888",
		placedAt: new Date(),
		fulfillmentStatus: "FULFILLED",
		total: 101.77,
		sourceUpdatedAt: new Date(),
	});
});

test("a changed deadline rewrites the same legacy row, preserving the parent and total", async () => {
	const transaction = vi.spyOn(db, "transaction");
	await saveReturns(db, store, [request()]);
	await saveReturns(db, store, [request()]);
	expect(transaction).toHaveBeenCalledTimes(1);
	await saveReturns(db, store, [request(1793164840)]);
	expect(transaction).toHaveBeenCalledTimes(2);
	expect(await db.select().from(returnRequests)).toMatchObject([
		{
			externalId: "4035352486720738032",
			caseRef: "4035352489823474416",
			amount: "101.77",
			currency: "USD",
			respondBy: new Date("2026-10-28T05:20:40Z"),
			waitingOn: "us",
			nextAction: "SELLER_RESPOND_REFUND",
		},
	]);
});

test("owner, escalation, action, amount and case reference changes also rewrite", async () => {
	const transaction = vi.spyOn(db, "transaction");
	const base = request();
	await saveReturns(db, store, [base]);
	const variants = [
		{ ...base, escalation: "in_progress" as const },
		{ ...base, nextAction: "SUBMIT_EVIDENCE" },
		{ ...base, caseRef: "different-parent" },
		{ ...base, amount: "27.87", currency: "USD" },
		{ ...base, amount: "101.77", currency: "EUR" },
		{
			...base,
			status: "requested" as const,
			waitingOn: "marketplace" as const,
			respondBy: null,
		},
	];
	for (const variant of variants) {
		await saveReturns(db, store, [base]);
		const before = transaction.mock.calls.length;
		await saveReturns(db, store, [variant]);
		expect(transaction).toHaveBeenCalledTimes(before + 1);
	}
});

test.each([
	{ status: "closed", waitingOn: "us", respondBy: null },
	{ status: "requested", waitingOn: "nobody", respondBy: null },
	{ waitingOn: "buyer", respondBy: new Date() },
	{ amount: "10", currency: null },
	{ amount: null, currency: "USD" },
	{ kind: "refund", status: "shipped" },
] as const)("the database rejects illegal combinations: %o", async (values) => {
	await saveReturns(db, store, [request()]);
	await expect(db.update(returnRequests).set(values)).rejects.toThrow();
});

test("open_cases and the Returns queue retain processing, sort deadlines, and exclude resolved rows", async () => {
	const first = request();
	const second = { ...request(1793164840), externalId: "second" };
	const processing = {
		...first,
		externalId: "processing",
		status: "processing" as const,
		waitingOn: "marketplace" as const,
		respondBy: null,
	};
	const resolved = {
		...first,
		externalId: "resolved",
		status: "closed" as const,
		waitingOn: "nobody" as const,
		respondBy: null,
	};
	await saveReturns(db, store, [processing, second, resolved, first]);
	expect(
		(await db.select().from(openCases)).map((row) => row.externalId),
	).toEqual([first.externalId, "second", "processing"]);
	const listed = await listReturns(db);
	expect(listed.cases.map((row) => row.waitingOn)).toEqual([
		"us",
		"us",
		"marketplace",
	]);
	expect(listed.refunds).toHaveLength(2);
	const [saved] = await db
		.select()
		.from(returnRequests)
		.where(eq(returnRequests.externalId, first.externalId));
	expect(saved.respondBy).toEqual(first.respondBy);
});

test("the type boundary rejects illegal states and unpaired money", () => {
	// @ts-expect-error Only seller work carries a deadline.
	const buyer: RequestStage = {
		kind: "return",
		status: "requested",
		waitingOn: "buyer",
		respondBy: new Date(),
		escalation: null,
	};
	// @ts-expect-error Resolved requests cannot wait on us.
	const resolved: RequestStage = {
		kind: "return",
		status: "closed",
		waitingOn: "us",
		respondBy: null,
		escalation: null,
	};
	// @ts-expect-error Refunds never ship.
	const shipped: RequestStage = {
		kind: "refund",
		status: "shipped",
		waitingOn: "marketplace",
		respondBy: null,
		escalation: null,
	};
	// @ts-expect-error An amount always has a currency.
	const money: CaseMoney = { amount: "10", currency: null };
	expect([buyer, resolved, shipped, money]).toHaveLength(4);
});

test("unknown statuses are saved without becoming seller work and surface as import problems", async () => {
	const unknown = tiktokToReturn({
		return_id: "unknown",
		order_id: "577620148777947888",
		return_status: "FUTURE_STATE",
		create_time: 1792000000,
	});
	expect(await importReturns(db, store, async () => [unknown])).toEqual({
		kind: "read",
		problems: ["Unknown TikTok return status: FUTURE_STATE"],
		held: [],
	});
	expect(await db.select().from(openCases)).toMatchObject([
		{ status: "unknown", waitingOn: "marketplace", respondBy: null },
	]);
});

test("the migration backfills legacy owners without guessing unknown TikTok work", async () => {
	const [order] = await db.select({ id: orders.id }).from(orders);
	const base = {
		orderId: order.id,
		billedBy: "tiktok" as const,
		status: "requested" as const,
		waitingOn: "us" as const,
		requestedAt: new Date(),
		sourceUpdatedAt: new Date(),
	};
	await db.insert(returnRequests).values([
		{ ...base, externalId: "buyer", rawStatus: "AWAITING_BUYER_SHIP" },
		{
			...base,
			externalId: "seller",
			rawStatus: "RETURN_OR_REFUND_REQUEST_PENDING",
		},
		{ ...base, externalId: "unknown", rawStatus: "FUTURE_STATUS" },
		{
			...base,
			externalId: "amazon",
			billedBy: "amazon",
			rawStatus: "Approved",
		},
		{
			...base,
			externalId: "closed",
			rawStatus: "RETURN_OR_REFUND_REQUEST_COMPLETE",
			status: "closed",
			waitingOn: "nobody",
		},
	]);
	const migration = readFileSync(
		new URL("../../drizzle/0148_case_obligations.sql", import.meta.url),
		"utf8",
	);
	const backfill = migration.match(
		/UPDATE "return_requests" SET "waiting_on" = CASE[\s\S]*?END;/,
	)?.[0];
	if (!backfill) throw new Error("Case obligation backfill missing");
	await db.execute(sql.raw(backfill));
	const rows = await db
		.select()
		.from(returnRequests)
		.orderBy(returnRequests.externalId);
	expect(rows.map((row) => [row.externalId, row.waitingOn])).toEqual([
		["amazon", "buyer"],
		["buyer", "buyer"],
		["closed", "nobody"],
		["seller", "us"],
		["unknown", "marketplace"],
	]);
});

test.each([
	false,
	true,
])("unknown arbitration saves an unknown badge and retains seller work: %s", async (sellerAction) => {
	const unknown = tiktokToReturn({
		return_id: "unknown-arbitration",
		order_id: "577620148777947888",
		return_status: "RETURN_OR_REFUND_REQUEST_COMPLETE",
		arbitration_status: "FUTURE_ARBITRATION",
		create_time: 1792000000,
		seller_next_action_response: sellerAction
			? [{ action: "SUBMIT_EVIDENCE", deadline: 1793037279 }]
			: [],
	});
	expect(await importReturns(db, store, async () => [unknown])).toEqual({
		kind: "read",
		problems: ["Unknown TikTok arbitration status: FUTURE_ARBITRATION"],
		held: [],
	});
	const [saved] = await db.select().from(returnRequests);
	expect(saved).toMatchObject({
		status: "unknown",
		escalation: null,
		waitingOn: sellerAction ? "us" : "marketplace",
		respondBy: sellerAction ? new Date(1793037279000) : null,
		nextAction: sellerAction ? "SUBMIT_EVIDENCE" : null,
	});
	const html = renderToStaticMarkup(
		createElement(
			TooltipProvider,
			null,
			createElement(CaseObligation, { request: saved }),
		),
	);
	expect(html).toContain("Unknown status");
	expect(html).not.toContain("TikTok processing");
	if (sellerAction) expect(html).toMatch(/overdue|left/);
});
