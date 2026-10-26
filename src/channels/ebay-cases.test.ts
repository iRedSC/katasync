import { eq } from "drizzle-orm";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { Db } from "#/db/client";
import { feedHealth, marketplaceCases } from "#/db/schema";
import { recordFeed } from "#/diagnostics/feed-record";
import { createTestDb } from "#/test/db";
import { accessToken } from "./ebay";
import { DISPUTE_SCOPE } from "./ebay-case-api";
import { fetchEbayCases } from "./ebay-cases";
import { ebayCasesPass } from "./ebay-cases-pass";

vi.mock("./ebay", () => ({ accessToken: vi.fn(async () => "token") }));
const now = new Date("2026-10-26T12:00:00Z");
const date = { value: "2026-10-25T12:00:00Z" };
const empty = {
	members: [],
	cancellations: [],
	paginationOutput: { totalPages: 0 },
};
let db: Db;
beforeEach(async () => {
	db = await createTestDb();
	vi.mocked(accessToken).mockReset().mockResolvedValue("token");
	vi.stubGlobal(
		"fetch",
		vi.fn(async () => Response.json(empty)),
	);
});
afterEach(() => vi.unstubAllGlobals());

test("Post-Order pagination reads every page and detail with IAF, using GET only", async () => {
	vi.stubGlobal(
		"fetch",
		vi.fn(async (input: URL, options: RequestInit) => {
			expect(options.method).toBeUndefined();
			expect(options.headers).toMatchObject({ Authorization: "IAF token" });
			if (input.pathname.endsWith("/search"))
				return Response.json({
					members: [
						{
							inquiryId: Number(input.searchParams.get("offset")),
							inquiryStatusEnum: "OPEN",
							creationDate: date,
						},
					],
					paginationOutput: { totalPages: 2 },
				});
			return Response.json({
				status: "WAITING_SELLER_RESPONSE",
				sellerMakeItRightByDate: { value: "2026-10-28T12:00:00Z" },
			});
		}),
	);
	const found = [];
	for await (const row of fetchEbayCases(
		"inquiry",
		new Date("2026-10-25"),
		now,
		Date.now() + 10_000,
	))
		found.push(row);
	expect(found.map((row) => row.externalId)).toEqual(["1", "2"]);
	expect(found[0]).toMatchObject({
		waitingOn: "us",
		respondBy: new Date("2026-10-28T12:00:00Z"),
	});
});

test("cancellations and escalations save even when their orders are absent", async () => {
	await recordFeed(db, "ebay", "cases", new Date(now.getTime() - 1000), {
		kind: "read",
		problems: [],
		readThrough: now,
	});
	vi.stubGlobal(
		"fetch",
		vi.fn(async (input: URL) => {
			if (input.pathname.endsWith("/cancellation/search"))
				return Response.json({
					cancellations: [
						{
							cancelId: "C1",
							cancelState: "APPROVAL_PENDING",
							cancelRequestDate: date,
						},
					],
					paginationOutput: { totalPages: 1 },
				});
			if (input.pathname.endsWith("/cancellation/C1"))
				return Response.json({
					cancelDetail: {
						cancelState: "APPROVAL_PENDING",
						sellerResponseDueDate: { value: "2026-10-28T12:00:00Z" },
					},
				});
			if (input.pathname.endsWith("/casemanagement/search"))
				return Response.json({
					members: [
						{ caseId: 2, caseStatusEnum: "WAITING_CS", creationDate: date },
					],
					paginationOutput: { totalPages: 1 },
				});
			if (input.pathname.endsWith("/casemanagement/2"))
				return Response.json({ status: "WAITING_CS", returnId: "R1" });
			return Response.json(empty);
		}),
	);
	expect(
		await ebayCasesPass(db, "cases", now, Date.now() + 10_000),
	).toMatchObject({ kind: "read", problems: [] });
	expect(await db.select().from(marketplaceCases)).toMatchObject([
		{
			kind: "cancellation",
			orderId: null,
			waitingOn: "us",
			respondBy: new Date("2026-10-28T12:00:00Z"),
		},
		{
			kind: "escalation",
			orderId: null,
			waitingOn: "marketplace",
			escalation: "in_progress",
		},
	]);
});

test("cancellation discovery includes both initiators and uses entry offsets", async () => {
	const searches: string[] = [];
	vi.stubGlobal(
		"fetch",
		vi.fn(async (input: URL) => {
			searches.push(
				`${input.searchParams.get("role")}:${input.searchParams.get("offset")}`,
			);
			return Response.json({
				cancellations: [],
				paginationOutput: { totalPages: 2 },
			});
		}),
	);
	for await (const _row of fetchEbayCases(
		"cancellation",
		new Date("2026-10-25"),
		now,
		Date.now() + 10_000,
	)) {
		throw new Error("Expected no cases");
	}
	expect(searches).toEqual(["BUYER:0", "BUYER:100", "SELLER:0", "SELLER:100"]);
});

test("missing dispute consent is named, blocks green, and retries only after the credential changes", async () => {
	vi.stubEnv("EBAY_REFRESH_TOKEN", "old-token");
	vi.mocked(accessToken).mockRejectedValue(
		new Error("eBay login failed: 400 invalid_scope"),
	);
	expect(
		await ebayCasesPass(db, "disputes", now, Date.now() + 10_000),
	).toMatchObject({
		kind: "failed",
		error: expect.stringContaining("Needs eBay re-authorization"),
	});
	expect(accessToken).toHaveBeenCalledWith(DISPUTE_SCOPE);
	await ebayCasesPass(
		db,
		"disputes",
		new Date(now.getTime() + 1000),
		Date.now() + 10_000,
	);
	expect(accessToken).toHaveBeenCalledTimes(1);
	vi.stubEnv("EBAY_REFRESH_TOKEN", "new-token");
	vi.mocked(accessToken).mockResolvedValue("new-access");
	vi.stubGlobal(
		"fetch",
		vi.fn(async () => Response.json({ paymentDisputeSummaries: [] })),
	);
	expect(
		await ebayCasesPass(
			db,
			"disputes",
			new Date(now.getTime() + 2000),
			Date.now() + 10_000,
		),
	).toMatchObject({ kind: "read", problems: [] });
	expect(accessToken).toHaveBeenCalledTimes(2);
});

test("disputes use Bearer and detail evidence deadlines; a changed deadline rewrites the row", async () => {
	await recordFeed(db, "ebay", "disputes", new Date(now.getTime() - 1000), {
		kind: "read",
		problems: [],
		readThrough: now,
	});
	let due = "2026-10-28T12:00:00Z";
	vi.stubGlobal(
		"fetch",
		vi.fn(async (input: URL, options: RequestInit) => {
			expect(options.headers).toMatchObject({ Authorization: "Bearer token" });
			expect(options.method).toBeUndefined();
			return Response.json(
				input.pathname.endsWith("/payment_dispute_summary")
					? {
							paymentDisputeSummaries: [
								{
									paymentDisputeId: "D1",
									paymentDisputeStatus: "ACTION_NEEDED",
									openDate: date.value,
									orderId: "not-here",
								},
							],
						}
					: {
							paymentDisputeId: "D1",
							paymentDisputeStatus: "ACTION_NEEDED",
							openDate: date.value,
							availableChoices: ["CONTEST"],
							evidenceRequests: [
								{ evidenceType: "PROOF_OF_DELIVERY", respondByDate: due },
							],
						},
			);
		}),
	);
	await ebayCasesPass(db, "disputes", now, Date.now() + 10_000);
	due = "2026-10-29T12:00:00Z";
	await ebayCasesPass(
		db,
		"disputes",
		new Date(now.getTime() + 1000),
		Date.now() + 10_000,
	);
	expect(await db.select().from(marketplaceCases)).toMatchObject([
		{ orderId: null, respondBy: new Date(due) },
	]);
});

test("detail failure never advances coverage or reports a clean feed", async () => {
	await recordFeed(db, "ebay", "cases", new Date(now.getTime() - 1000), {
		kind: "read",
		problems: [],
		readThrough: now,
	});
	vi.stubGlobal(
		"fetch",
		vi.fn(async (input: URL) =>
			input.pathname.endsWith("/search")
				? Response.json({
						members: [
							{ inquiryId: 1, inquiryStatusEnum: "OPEN", creationDate: date },
						],
						paginationOutput: { totalPages: 1 },
					})
				: new Response("no", { status: 503 }),
		),
	);
	expect(
		await ebayCasesPass(db, "cases", now, Date.now() + 10_000),
	).toMatchObject({ kind: "failed" });
	const [health] = await db
		.select()
		.from(feedHealth)
		.where(eq(feedHealth.feed, "cases"));
	expect(health).toMatchObject({ state: "failed", readThrough: now });
});

test("expired budget cannot turn an unread first pass green", async () => {
	expect(await ebayCasesPass(db, "cases", now, Date.now() - 1)).toMatchObject({
		kind: "catching_up",
	});
	expect(fetch).not.toHaveBeenCalled();
});

test("a malformed successful detail response cannot silently clear obligations", async () => {
	vi.stubGlobal(
		"fetch",
		vi.fn(async (input: URL) =>
			Response.json(
				input.pathname.endsWith("/search")
					? {
							members: [
								{ inquiryId: 1, inquiryStatusEnum: "OPEN", creationDate: date },
							],
							paginationOutput: { totalPages: 1 },
						}
					: {},
			),
		),
	);
	expect(
		await ebayCasesPass(db, "cases", now, Date.now() + 10_000),
	).toMatchObject({
		kind: "failed",
		error: expect.stringContaining("detail missing status"),
	});
	expect(await db.select().from(marketplaceCases)).toEqual([]);
});
