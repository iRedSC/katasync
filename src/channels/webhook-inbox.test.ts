import { sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import type { Db } from "#/db/client";
import { webhookInbox } from "#/db/webhook-schema";
import { createTestDb } from "#/test/db";
import {
	acceptWebhook,
	backlogSummary,
	claimDue,
	drainDue,
	type Ingest,
	settle,
} from "./webhook-inbox";

const ORDER = "gid://shopify/Order/5536";
const TARGET = { kind: "order", id: ORDER } as const;
const body = (updatedAt: string) =>
	JSON.stringify({ admin_graphql_api_id: ORDER, updated_at: updatedAt });
const ingestOk: Ingest = async () => ({ kind: "applied" });
const ingestBusy: Ingest = async () => ({ kind: "busy" });
const ingestFails: Ingest = async () => {
	throw new Error("Shopify 503");
};

let db: Db;

const rows = () => db.select().from(webhookInbox);

const expireLeases = () =>
	db
		.update(webhookInbox)
		.set({ leaseExpiresAt: sql`now() - interval '1 second'` });

const makeAllDue = () =>
	db
		.update(webhookInbox)
		.set({ nextAttemptAt: sql`now() - interval '1 second'` });

beforeEach(async () => {
	db = await createTestDb();
});

describe("acceptWebhook", () => {
	it("stores the verified order before it is acknowledged", async () => {
		await acceptWebhook(db, "shopify", TARGET, body("1"));
		const stored = await rows();
		expect(stored).toHaveLength(1);
		expect(stored[0]).toMatchObject({
			channel: "shopify",
			target: "order",
			targetKey: ORDER,
			generation: 1,
			failures: 0,
			leaseToken: null,
		});
		expect(stored[0].eventDigest).toMatch(/^[0-9a-f]{64}$/);
	});

	it("keys a case apart from its order, where code before targets reads orders", async () => {
		await acceptWebhook(db, "tiktok", { kind: "order", id: "577" }, body("1"));
		await acceptWebhook(
			db,
			"tiktok",
			{ kind: "order_returns", id: "577" },
			body("1"),
		);
		// As the code from before case targets still writes it.
		await db.execute(
			sql`insert into webhook_inbox (channel, order_id, event_digest) values ('tiktok', '578', 'x')`,
		);
		const stored = await rows();
		expect(stored.map((r) => [r.target, r.targetKey]).sort()).toEqual([
			["order", "577"],
			["order", "578"],
			["order_returns", "order_returns:577"],
		]);
		const claimed = await claimDue(db, 10);
		expect(claimed.map((c) => c.target)).toEqual(
			expect.arrayContaining([
				{ kind: "order", id: "577" },
				{ kind: "order", id: "578" },
				{ kind: "order_returns", id: "577" },
			]),
		);
	});

	it("rejects when the store fails, so the sender retries", async () => {
		const broken = {
			insert: () => {
				throw new Error("database unreachable");
			},
		} as unknown as Db;
		await expect(
			acceptWebhook(broken, "shopify", TARGET, body("1")),
		).rejects.toThrow("database unreachable");
	});

	it("coalesces duplicate deliveries into one row at the same generation", async () => {
		await acceptWebhook(db, "shopify", TARGET, body("1"));
		await acceptWebhook(db, "shopify", TARGET, body("1"));
		const stored = await rows();
		expect(stored).toHaveLength(1);
		expect(stored[0].generation).toBe(1);
	});

	it("bumps the generation on each changed event, never back down", async () => {
		await acceptWebhook(db, "shopify", TARGET, body("1"));
		await acceptWebhook(db, "shopify", TARGET, body("2"));
		await acceptWebhook(db, "shopify", TARGET, body("1"));
		const [stored] = await rows();
		expect(stored.generation).toBe(3);
	});
});

describe("drainDue", () => {
	it("completes an explicitly ignored relayed order", async () => {
		await acceptWebhook(db, "shopify", TARGET, body("1"));
		expect(
			await drainDue(db, async () => ({
				kind: "ignored",
				reason: "tiktok_source",
			})),
		).toMatchObject({ done: 1 });
		expect(await rows()).toHaveLength(0);
	});
	it("caps retry delay even after a prolonged failure", async () => {
		await acceptWebhook(db, "shopify", TARGET, body("1"));
		await db.update(webhookInbox).set({ failures: 2000 });
		expect(await drainDue(db, ingestFails)).toMatchObject({ failed: 1 });
		const [stored] = await rows();
		expect(stored.failures).toBe(2001);
		expect(stored.nextAttemptAt.getTime() - Date.now()).toBeGreaterThan(
			3500000,
		);
		expect(stored.nextAttemptAt.getTime() - Date.now()).toBeLessThan(3610000);
	});

	it("rejects unbounded or invalid claim batches", async () => {
		for (const limit of [0, -1, 11, 1.5])
			await expect(claimDue(db, limit)).rejects.toThrow("Claim limit");
	});
	it("keeps an order pending when ingest is busy, then repairs it on the next pass", async () => {
		await acceptWebhook(db, "shopify", TARGET, body("1"));
		const busy = await drainDue(db, ingestBusy);
		expect(busy).toMatchObject({ claimed: 1, busy: 1, done: 0 });
		const [pending] = await rows();
		expect(pending).toMatchObject({ failures: 0, leaseToken: null });

		await makeAllDue();
		const repaired = await drainDue(db, ingestOk);
		expect(repaired).toMatchObject({ claimed: 1, done: 1 });
		expect(await rows()).toHaveLength(0);
	});

	it("records a failed ingest as lastError and backs off", async () => {
		await acceptWebhook(db, "shopify", TARGET, body("1"));
		const failed = await drainDue(db, ingestFails);
		expect(failed).toMatchObject({ claimed: 1, failed: 1 });
		const [stored] = await rows();
		expect(stored).toMatchObject({ failures: 1, lastError: "Shopify 503" });
		expect(stored.lastErrorAt).not.toBeNull();

		const again = await drainDue(db, ingestOk);
		expect(again.claimed).toBe(0);
	});

	it("bounds how many orders one pass claims", async () => {
		for (let n = 1; n <= 12; n++)
			await acceptWebhook(
				db,
				"shopify",
				{ kind: "order", id: `gid://shopify/Order/${n}` },
				body("1"),
			);
		const first = await drainDue(db, ingestOk);
		expect(first).toMatchObject({ claimed: 10, done: 10 });
		expect(await rows()).toHaveLength(2);
	});
	it("leases each order only once it's reached, not the whole batch up front", async () => {
		for (let n = 1; n <= 3; n++)
			await acceptWebhook(db, "shopify", `gid://shopify/Order/${n}`, body("1"));
		const leasedWhileWorking: number[] = [];
		const report = await drainDue(db, async () => {
			const leased = (await rows()).filter((r) => r.leaseToken !== null);
			leasedWhileWorking.push(leased.length);
			return { kind: "applied" };
		});
		expect(report).toMatchObject({ claimed: 3, done: 3 });
		expect(leasedWhileWorking).toEqual([1, 1, 1]);
	});

	it("stops taking orders once its time is up, leaving the rest unleased", async () => {
		for (let n = 1; n <= 3; n++)
			await acceptWebhook(db, "shopify", `gid://shopify/Order/${n}`, body("1"));
		const slow: Ingest = async () => {
			await new Promise((resolve) => setTimeout(resolve, 30));
			return { kind: "applied" };
		};
		expect(await drainDue(db, slow, { forMs: 10 })).toMatchObject({
			claimed: 1,
			done: 1,
		});
		const left = await rows();
		expect(left).toHaveLength(2);
		expect(left.every((r) => r.leaseToken === null)).toBe(true);
	});
});

describe("claims and leases", () => {
	it("holds a claim until its lease expires, then lets another worker take it", async () => {
		await acceptWebhook(db, "shopify", TARGET, body("1"));
		const [first] = await claimDue(db, 10);
		expect(await claimDue(db, 10)).toHaveLength(0);

		await expireLeases();
		const [second] = await claimDue(db, 10);
		expect(second.leaseToken).not.toBe(first.leaseToken);
		expect(second.generation).toBe(1);
	});

	it("rejects a stale completion once a newer claim holds the order", async () => {
		await acceptWebhook(db, "shopify", TARGET, body("1"));
		const [stale] = await claimDue(db, 10);
		await expireLeases();
		const [current] = await claimDue(db, 10);

		expect(await settle(db, stale, { kind: "done" })).toBe("lost");
		const [stored] = await rows();
		expect(stored.leaseToken).toBe(current.leaseToken);

		expect(await settle(db, current, { kind: "done" })).toBe("done");
		expect(await rows()).toHaveLength(0);
	});

	it("lets a worker whose lease lapsed but was not reclaimed still finish", async () => {
		await acceptWebhook(db, "shopify", TARGET, body("1"));
		const [claim] = await claimDue(db, 10);
		await expireLeases();
		expect(await settle(db, claim, { kind: "done" })).toBe("done");
	});

	it("recovers an order whose worker crashed mid-ingest", async () => {
		await acceptWebhook(db, "shopify", TARGET, body("1"));
		await claimDue(db, 10);
		await expireLeases();
		const recovered = await drainDue(db, ingestOk);
		expect(recovered).toMatchObject({ claimed: 1, done: 1 });
		expect(await rows()).toHaveLength(0);
	});
});

describe("events arriving during ingest", () => {
	it("keeps the newer event pending instead of completing it with the older one", async () => {
		await acceptWebhook(db, "shopify", TARGET, body("1"));
		const [claim] = await claimDue(db, 10);
		await acceptWebhook(db, "shopify", TARGET, body("2"));

		expect(await settle(db, claim, { kind: "done" })).toBe("pending");
		const [stored] = await rows();
		expect(stored).toMatchObject({ generation: 2, leaseToken: null });

		const [next] = await claimDue(db, 10);
		expect(next.generation).toBe(2);
	});

	it("does not treat a repeat of the same event as new work", async () => {
		await acceptWebhook(db, "shopify", TARGET, body("1"));
		const [claim] = await claimDue(db, 10);
		await acceptWebhook(db, "shopify", TARGET, body("1"));

		expect(await settle(db, claim, { kind: "done" })).toBe("done");
		expect(await rows()).toHaveLength(0);
	});
});

describe("backlogSummary", () => {
	it("counts pending orders, their oldest age, and the latest error", async () => {
		await acceptWebhook(db, "shopify", TARGET, body("1"));
		await acceptWebhook(db, "tiktok", { kind: "order", id: "7001" }, body("1"));
		await db
			.update(webhookInbox)
			.set({ eventAt: sql`now() - interval '1 hour'` })
			.where(sql`${webhookInbox.channel} = 'shopify'`);
		await drainDue(db, ingestFails);

		const summary = await backlogSummary(db);
		expect(summary).toMatchObject({ pending: 2, failing: 2, leased: 0 });
		expect(summary.oldestAgeSeconds).toBeGreaterThanOrEqual(3600);
		expect(summary.lastError?.message).toBe("Shopify 503");
	});

	it("reports an empty inbox as nothing pending", async () => {
		expect(await backlogSummary(db)).toMatchObject({
			pending: 0,
			oldestAgeSeconds: null,
			lastError: null,
		});
	});
});
