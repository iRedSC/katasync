import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { bankMatches, bankMatchParts } from "#/db/banking-schema";
import { payouts } from "#/db/schema";
import { createTestDb } from "#/test/db";
import { confirmMatch, undoMatch } from "./matching";
import { loadOverview, matchOptions } from "./overview";
import { matchStates } from "./review";
import { account, bankRows, csv, imported, part, payout } from "./test-setup";

async function setup(lines: string[]) {
	const db = await createTestDb();
	const a = await account(db);
	await imported(db, a.id, csv(...lines));
	const rows = await bankRows(db, a.id);
	return { db, a, ids: rows.map((r) => r.id) };
}

describe("matching bank rows to payouts", () => {
	it("splits one deposit across payouts to the cent, and keeps what each payout said", async () => {
		const { db, a, ids } = await setup(["2026-10-02,SHOPIFY,150.00"]);
		const p1 = await payout(db, "P1", 100);
		const p2 = await payout(db, "P2", 80, {
			status: "pending",
			reference: null,
		});
		const short = await confirmMatch(db, {
			transactionId: ids[0],
			parts: [part(p1, 10000), part(p2, 4999)],
			replaces: null,
		});
		expect(short).toMatchObject({
			ok: false,
			problem: expect.stringContaining("add to"),
		});
		const r = await confirmMatch(db, {
			transactionId: ids[0],
			parts: [part(p1, 10000), part(p2, 5000)],
			replaces: null,
		});
		expect(r).toMatchObject({ ok: true, value: { kind: "matched" } });
		const parts = await db
			.select()
			.from(bankMatchParts)
			.orderBy(bankMatchParts.id);
		expect(
			parts.map((p) => [
				p.amountCents,
				p.observedAmountCents,
				p.observedStatus,
			]),
		).toEqual([
			[10000, 10000, "sent"],
			[5000, 8000, "pending"],
		]);
		const o = await loadOverview(db, a.id);
		expect(o.rows[0].state.kind).toBe("matched");
		expect(o.payouts.map((p) => [p.label, p.status, p.bank])).toEqual(
			expect.arrayContaining([
				["Shopify payout P1", "sent", "matched"],
				["Shopify payout P2", "pending", "partial"],
			]),
		);
	});

	it("only suggests, and never confirms on its own", async () => {
		const { db, ids } = await setup(["2026-10-02,SHOPIFY,100.00"]);
		await payout(db, "P1", 100);
		await payout(db, "P2", 100, {
			depositedAt: new Date("2026-10-02T15:00:00Z"),
		});
		const options = await matchOptions(db, ids[0]);
		expect(options?.suggestions).toHaveLength(2);
		expect(options?.ambiguous).toBe(true);
		expect(await db.select().from(bankMatches)).toHaveLength(0);
	});

	it("treats a repeated submit as the same match, and refuses a different one", async () => {
		const { db, ids } = await setup(["2026-10-02,SHOPIFY,100.00"]);
		const p1 = await payout(db, "P1", 100);
		const p2 = await payout(db, "P2", 100);
		const first = await confirmMatch(db, {
			transactionId: ids[0],
			parts: [part(p1, 10000)],
			replaces: null,
		});
		const again = await confirmMatch(db, {
			transactionId: ids[0],
			parts: [part(p1, 10000)],
			replaces: null,
		});
		expect(again).toEqual({
			ok: true,
			value: { kind: "already", matchId: first.ok ? first.value.matchId : -1 },
		});
		const other = await confirmMatch(db, {
			transactionId: ids[0],
			parts: [part(p2, 10000)],
			replaces: null,
		});
		expect(other.ok).toBe(false);
		expect(await db.select().from(bankMatches)).toHaveLength(1);
	});

	it("never matches a payout past its amount, even when two confirm at once", async () => {
		const { db, ids } = await setup([
			"2026-10-02,A,100.00",
			"2026-10-03,B,100.00",
		]);
		const p = await payout(db, "P1", 150);
		const results = await Promise.all(
			ids.map((transactionId) =>
				confirmMatch(db, {
					transactionId,
					parts: [part(p, 10000)],
					replaces: null,
				}),
			),
		);
		expect(results.filter((r) => r.ok)).toHaveLength(1);
		const parts = await db
			.select()
			.from(bankMatchParts)
			.where(eq(bankMatchParts.payoutId, p));
		expect(parts.map((x) => x.amountCents)).toEqual([10000]);
	});

	it("refuses a payout in another currency rather than converting", async () => {
		const { db, ids } = await setup(["2026-10-02,A,100.00"]);
		const p = await payout(db, "P1", 100, { currency: "CAD" });
		const r = await confirmMatch(db, {
			transactionId: ids[0],
			parts: [part(p, 10000)],
			replaces: null,
		});
		expect(r).toEqual({
			ok: false,
			problem: expect.stringContaining("conversion"),
		});
		expect(await matchOptions(db, ids[0])).toMatchObject({
			candidates: [],
			suggestions: [],
		});
	});

	it("undoes a match keeping its evidence, freeing the payout", async () => {
		const { db, a, ids } = await setup([
			"2026-10-02,A,100.00",
			"2026-10-03,B,100.00",
		]);
		const p = await payout(db, "P1", 100);
		const r = await confirmMatch(db, {
			transactionId: ids[0],
			parts: [part(p, 10000)],
			replaces: null,
		});
		if (!r.ok) throw new Error(r.problem);
		expect(await undoMatch(db, r.value.matchId)).toMatchObject({
			ok: true,
			value: { kind: "undone", parts: [part(p, 10000)] },
		});
		expect(await undoMatch(db, r.value.matchId)).toMatchObject({
			ok: true,
			value: { kind: "already" },
		});
		expect(await db.select().from(bankMatchParts)).toHaveLength(1);
		const [m] = await db.select().from(bankMatches);
		expect(m.undoneAt).not.toBeNull();
		await expect(db.delete(bankMatches)).rejects.toThrow();
		await expect(
			db.update(bankMatches).set({ undoneAt: null }),
		).rejects.toThrow();
		const other = await confirmMatch(db, {
			transactionId: ids[1],
			parts: [part(p, 10000)],
			replaces: null,
		});
		expect(other.ok).toBe(true);
		const o = await loadOverview(db, a.id);
		expect(o.rows.find((x) => x.id === ids[0])).toMatchObject({
			pastMatches: 1,
			state: { kind: "unmatched" },
		});
	});

	it("shows a match whose payout changed upstream as needs review, never as matched", async () => {
		const { db, a, ids } = await setup(["2026-10-02,A,100.00"]);
		const p = await payout(db, "P1", 100, { status: "pending" });
		const r = await confirmMatch(db, {
			transactionId: ids[0],
			parts: [part(p, 10000)],
			replaces: null,
		});
		if (!r.ok) throw new Error(r.problem);
		const state = async () =>
			(await matchStates(db, ids, a.currency)).states.get(ids[0]);
		await db
			.update(payouts)
			.set({ status: "sent", reference: "TR1" })
			.where(eq(payouts.id, p));
		expect(await state()).toMatchObject({ kind: "matched" });
		await db.update(payouts).set({ amount: 90 }).where(eq(payouts.id, p));
		expect(await state()).toMatchObject({
			kind: "needs-review",
			reasons: [expect.stringContaining("Amount")],
		});
		await db.update(payouts).set({ status: "failed" }).where(eq(payouts.id, p));
		expect((await state())?.kind).toBe("needs-review");
		const again = await confirmMatch(db, {
			transactionId: ids[0],
			parts: [part(p, 10000)],
			replaces: r.value.matchId,
		});
		expect(again.ok).toBe(false);
	});

	it("catches a payout that changed and changed back", async () => {
		const { db, a, ids } = await setup(["2026-10-02,A,100.00"]);
		const p = await payout(db, "P1", 100);
		const r = await confirmMatch(db, {
			transactionId: ids[0],
			parts: [part(p, 10000)],
			replaces: null,
		});
		if (!r.ok) throw new Error(r.problem);
		await db.update(payouts).set({ amount: 90 }).where(eq(payouts.id, p));
		await db.update(payouts).set({ amount: 100 }).where(eq(payouts.id, p));
		const states = (await matchStates(db, ids, a.currency)).states;
		expect(states.get(ids[0])).toMatchObject({
			kind: "needs-review",
			reasons: [expect.stringContaining("changed back")],
		});
		const again = await confirmMatch(db, {
			transactionId: ids[0],
			parts: [part(p, 10000)],
			replaces: r.value.matchId,
		});
		expect(again).toMatchObject({ ok: true, value: { kind: "matched" } });
		expect(
			(await matchStates(db, ids, a.currency)).states.get(ids[0])?.kind,
		).toBe("matched");
		const stale = await confirmMatch(db, {
			transactionId: ids[0],
			parts: [part(p, 10000)],
			replaces: r.value.matchId,
		});
		expect(stale.ok).toBe(false);
	});
});
