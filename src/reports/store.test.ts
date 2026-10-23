import { and, eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, test } from "vitest";
import type { Db } from "#/db/client";
import {
	reportArtifacts,
	reportHandoffs,
	reportSnapshots,
} from "#/db/report-schema";
import * as schema from "#/db/schema";
import { saveCostReport } from "#/orders/charges";
import { profitTotals } from "#/orders/profit";
import { type ProfitFixture, profitFixture } from "#/orders/profit.fixtures";
import { type Period, parsePeriod, periodWindow } from "#/orders/sales-report";
import { reportChanges } from "./diff";
import {
	handOff,
	listRevisions,
	liveState,
	readArtifact,
	readReport,
	saveRevision,
	sha256,
} from "./store";

let db: Db;
let amazon: number;
let order: ProfitFixture["order"];
let profit: ProfitFixture["profit"];

const causedBy = (message: RegExp) => ({
	cause: expect.objectContaining({ message: expect.stringMatching(message) }),
});

const september = parsePeriod("2026-09") as Period;
const june = parsePeriod("2026-06") as Period;

beforeEach(async () => {
	({ db, amazon, order, profit } = await profitFixture());
});

async function sale(name: string, placedAt: Date, unitCost: number | null = 8) {
	return order(name, [{ unitPrice: 20, quantity: 1, unitCost }], { placedAt });
}

function report(
	orderId: number,
	charges: { kind: "fee" | "refund"; amount: number }[],
	settled = false,
) {
	return saveCostReport(db, {
		orderId,
		billedBy: "shopify",
		settled,
		noLabel: true,
		charges: charges.map((c) => ({ ...c, description: c.kind })),
	});
}

async function filesOf(snapshotId: number) {
	const names = await db
		.select({ name: reportArtifacts.name })
		.from(reportArtifacts)
		.where(eq(reportArtifacts.snapshotId, snapshotId));
	const files = new Map<string, string>();
	for (const { name } of names)
		files.set(name, (await readArtifact(db, { snapshotId, name })).content);
	return files;
}

describe("saved revisions", () => {
	test("keep their files byte for byte after a later refund", async () => {
		const a = await sale("#a", new Date("2026-09-15T15:00:00Z"));
		await report(a.id, [{ kind: "fee", amount: 1 }]);
		const first = await saveRevision(db, september);
		expect(first).toMatchObject({ kind: "saved", revision: 1 });
		const before = await filesOf(first.id);
		expect([...before.keys()].sort()).toEqual([
			"about.csv",
			"contribution.csv",
			"deposits.csv",
			"evidence.csv",
			"report.html",
			"sales-by-state.csv",
			"sales-tax.csv",
			"sales.csv",
		]);

		await report(a.id, [
			{ kind: "fee", amount: 1 },
			{ kind: "refund", amount: 5 },
		]);
		const second = await saveRevision(db, september);
		expect(second).toMatchObject({ kind: "saved", revision: 2 });
		expect(second.digest).not.toBe(first.digest);

		const after = await filesOf(first.id);
		expect(after).toEqual(before);
		for (const [name, content] of after) {
			const [row] = await db
				.select({ sha256: reportArtifacts.sha256 })
				.from(reportArtifacts)
				.where(
					and(
						eq(reportArtifacts.snapshotId, first.id),
						eq(reportArtifacts.name, name),
					),
				);
			expect(row.sha256).toBe(sha256(before.get(name) ?? ""));
			expect(sha256(content)).toBe(row.sha256);
		}

		const [newer, older] = await listRevisions(db, september);
		expect(older.state).toEqual({ kind: "superseded", by: 2 });
		expect(newer.state).toEqual({ kind: "current" });
		expect(older.data.channels[0].refunds).toBe(0);
		expect(newer.data.channels[0].refunds).toBe(5);
		expect(reportChanges(older.data, newer.data)).toContainEqual(
			expect.objectContaining({ field: "refunds", before: 0, after: 5 }),
		);
	});

	test("aren't saved again when nothing changed, even twice at once", async () => {
		await sale("#a", new Date("2026-09-15T15:00:00Z"));
		const results = await Promise.all([
			saveRevision(db, september),
			saveRevision(db, september),
		]);
		expect(results.map((r) => r.kind).sort()).toEqual(["saved", "unchanged"]);
		expect(new Set(results.map((r) => r.digest)).size).toBe(1);
		expect(await listRevisions(db, september)).toHaveLength(1);
	});

	test("are numbered per month", async () => {
		await sale("#a", new Date("2026-09-15T15:00:00Z"));
		const sept = await saveRevision(db, september);
		const jun = await saveRevision(db, june);
		expect([sept.revision, jun.revision]).toEqual([1, 1]);
		const [row] = await db
			.select()
			.from(reportSnapshots)
			.where(eq(reportSnapshots.id, sept.id));
		const { id: _, ...copy } = row;
		await expect(
			db.transaction((tx) =>
				tx
					.insert(reportSnapshots)
					.values({ ...copy, asOf: sql`now()`, digest: "x" }),
			),
		).rejects.toMatchObject(causedBy(/report_snapshots_revision/));
		await expect(
			db.insert(reportSnapshots).values({
				...copy,
				revision: 2,
				asOf: new Date("2026-01-01T00:00:00Z"),
				digest: "y",
			}),
		).rejects.toMatchObject(causedBy(/saving transaction/));
	});

	test("can't be changed, deleted or added to later", async () => {
		await sale("#a", new Date("2026-09-15T15:00:00Z"));
		const saved = await saveRevision(db, september);
		await expect(
			db
				.update(reportArtifacts)
				.set({ content: "tampered" })
				.where(eq(reportArtifacts.snapshotId, saved.id)),
		).rejects.toMatchObject(causedBy(/append-only/));
		await expect(
			db.delete(reportSnapshots).where(eq(reportSnapshots.id, saved.id)),
		).rejects.toMatchObject(causedBy(/append-only/));
		await expect(
			db.insert(reportArtifacts).values({
				snapshotId: saved.id,
				name: "late.csv",
				mediaType: "text/csv",
				content: "a\r\n",
				sha256: sha256("a\r\n"),
			}),
		).rejects.toMatchObject(causedBy(/with their revision/));
	});

	test("read every section from the one transaction", async () => {
		const sentinel = new Error("roll back");
		await expect(
			db.transaction(async (tx) => {
				const [row] = await tx
					.insert(schema.orders)
					.values({
						storeId: amazon,
						externalId: "#tx",
						name: "#tx",
						marketplaceOrderId: "amazon:tx",
						placedAt: new Date("2026-09-20T15:00:00Z"),
						fulfillmentStatus: "FULFILLED",
						total: 0,
						sourceUpdatedAt: new Date(),
					})
					.returning();
				const [wrench] = await tx
					.select({ id: schema.products.id })
					.from(schema.products)
					.limit(1);
				await tx.insert(schema.orderLines).values({
					orderId: row.id,
					externalId: "#tx-0",
					productId: wrench.id,
					title: "Wrench",
					unitPrice: 50,
					quantity: 1,
					unitCost: 10,
				});
				const { data } = await readReport(tx, september);
				expect(data.channels.map((c) => c.orders)).toEqual([1]);
				expect(data.evidence.map((e) => e.orders)).toEqual([1]);
				expect(data.contribution.orders).toBe(1);
				throw sentinel;
			}),
		).rejects.toBe(sentinel);
		const { data } = await db.transaction((tx) => readReport(tx, september));
		expect(data.channels).toEqual([]);
		expect(data.evidence).toEqual([]);
		expect(data.contribution.orders).toBe(0);
	});

	test("take contribution and cost corrections from profitTotals", async () => {
		await sale("#a", new Date("2026-09-15T15:00:00Z"));
		await sale("#b", new Date("2026-09-16T15:00:00Z"), null);
		const { data } = await db.transaction((tx) => readReport(tx, september));
		const window = await periodWindow(db, september);
		const totals = await profitTotals(db, window.start, window.end);
		expect(data.contribution).toMatchObject({
			contribution: totals.profit,
			costCorrections: totals.costCorrections,
			costUnknown: 1,
		});
		const saved = await saveRevision(db, september);
		const csv = await readArtifact(db, {
			snapshotId: saved.id,
			name: "contribution.csv",
		});
		expect(csv.content).toMatch(/Contribution before overhead,,,"Unknown: 1 /);
		expect(csv.filename).toBe("contribution-2026-09-r1.csv");
	});
});

describe("fee evidence", () => {
	test("keeps fees old enough to read as final apart from settled ones", async () => {
		const aged = await sale("#aged", new Date("2026-06-15T15:00:00Z"));
		const settled = await sale("#settled", new Date("2026-06-16T15:00:00Z"));
		await report(aged.id, [{ kind: "fee", amount: 1 }]);
		await report(settled.id, [{ kind: "fee", amount: 2 }], true);
		expect((await profit(aged.id)).feesStatus).toBe("final");
		expect((await profit(settled.id)).feesStatus).toBe("final");
		const { data } = await db.transaction((tx) => readReport(tx, june));
		expect(data.evidence[0].fees).toEqual({
			settled: { orders: 1, amount: 2 },
			reported: { orders: 0, amount: 0 },
			aged_out: { orders: 1, amount: 1 },
			estimated: { orders: 0, amount: 0 },
		});
	});
});

describe("handoffs", () => {
	test("name one revision by its digest, superseded or not", async () => {
		const a = await sale("#a", new Date("2026-09-15T15:00:00Z"));
		const first = await saveRevision(db, september);
		await expect(
			handOff(db, {
				snapshotId: first.id,
				digest: "0".repeat(64),
				recipient: "Accountant",
			}),
		).rejects.toThrow(/doesn't match/);
		await expect(
			handOff(db, {
				snapshotId: first.id,
				digest: first.digest,
				recipient: " ",
			}),
		).rejects.toThrow(/who/i);

		await report(a.id, [{ kind: "refund", amount: 5 }]);
		const second = await saveRevision(db, september);
		await handOff(db, {
			snapshotId: first.id,
			digest: first.digest,
			recipient: "Accountant",
			note: "Q3 close",
		});
		await expect(
			db.delete(reportHandoffs).where(eq(reportHandoffs.snapshotId, first.id)),
		).rejects.toMatchObject(causedBy(/append-only/));

		const revisions = await listRevisions(db, september);
		const old = revisions.find((r) => r.id === first.id);
		expect(old?.handoffs).toMatchObject([
			{ recipient: "Accountant", note: "Q3 close" },
		]);
		expect(old?.state).toEqual({ kind: "superseded", by: second.revision });
		expect(revisions.find((r) => r.id === second.id)?.handoffs).toEqual([]);

		await report(a.id, [{ kind: "refund", amount: 7 }]);
		const { dataDigest } = await db.transaction((tx) =>
			readReport(tx, september),
		);
		expect(liveState(dataDigest, revisions)).toEqual({
			kind: "changed",
			since: 2,
			handedOff: true,
		});
	});
});
