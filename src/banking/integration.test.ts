import { and, eq, isNull, sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { audited } from "#/audit/audited-db";
import { runAs } from "#/audit/context";
import { systemActor } from "#/auth/actor";
import {
	bankAccounts,
	bankImports,
	bankMatches,
	bankTransactions,
} from "#/db/banking-schema";
import { auditEvents } from "#/db/identity-schema";
import { payouts } from "#/db/schema";
import { answered, createIntent } from "#/lib/intent";
import { createTestDb } from "#/test/db";
import { commitImport, previewImport } from "./imports";
import { confirmMatch, undoMatch } from "./matching";
import { loadOverview } from "./overview";
import { payoutTarget } from "./targets";
import {
	account,
	bankRows,
	csv,
	imported,
	MAPPING,
	part,
	payout,
} from "./test-setup";

const actor = systemActor("script");

describe("banking integration boundaries", () => {
	it("reclassifies a definitive retry refusal so correction is reachable", async () => {
		const db = await createTestDb();
		const made = await account(db);
		const input = {
			accountId: made.id,
			text: csv("2026-10-01,A,10"),
			fileName: null,
			mapping: MAPPING,
			skipRows: [] as number[],
		};
		const intent = createIntent<typeof input>();
		await intent.run(
			() => input,
			async () => ({ kind: "uncertain" }),
		);
		expect(intent.getSnapshot().kind).toBe("retry");
		const other = await commitImport(db, { ...input, skipRows: [1] }, actor);
		if (!other.ok) throw new Error(other.problem);
		const refused = await intent.run(
			() => ({ ...input, skipRows: [1] }),
			async (payload) =>
				answered({ value: await commitImport(db, payload, actor) }),
		);
		expect(refused).toMatchObject({
			kind: "rejected",
			problem: expect.stringContaining("Correct import"),
		});
		expect(intent.getSnapshot().kind).toBe("idle");
		expect(await previewImport(db, input)).toMatchObject({
			ok: true,
			value: { alreadyImported: other.value.importId },
		});
	});
	it("retains foreign-symbol rows as invalid rather than matching them as USD", async () => {
		const db = await createTestDb();
		const made = await account(db);
		const result = await imported(
			db,
			made.id,
			csv("2026-10-01,Euro,€100.00", "2026-10-01,Pound,£100.00"),
		);
		expect(result).toMatchObject({ kind: "imported", added: 0, invalid: 2 });
		expect(await bankRows(db, made.id)).toHaveLength(0);
	});

	it("keeps disputed payout evidence visible across accounts and beyond the row limit", async () => {
		const db = await createTestDb();
		const first = await account(db, "A");
		const second = await account(db, "B");
		await imported(db, first.id, csv("2026-10-01,Deposit,10"));
		await imported(db, second.id, csv("2026-10-01,Nearby,1"));
		const [row] = await bankRows(db, first.id);
		const targetId = await payout(db, "DISPUTED", 10, { reference: "BEFORE" });
		expect(
			await confirmMatch(
				db,
				{
					transactionId: row.id,
					parts: [part(targetId, 1000)],
					replaces: null,
				},
				actor,
			),
		).toMatchObject({ ok: true });
		await db
			.update(payouts)
			.set({ reference: "AFTER" })
			.where(eq(payouts.id, targetId));
		expect(
			(await loadOverview(db, second.id)).payouts.find(
				(target) => target.ref.id === targetId,
			)?.bank,
		).toBe("needs-review");
		await imported(
			db,
			first.id,
			csv(
				...Array.from(
					{ length: 1001 },
					(_, index) => `2026-10-02,New ${index},1`,
				),
			),
		);
		const overview = await loadOverview(db, first.id);
		expect(overview.truncated).toBe(true);
		expect(overview.rows.some((visible) => visible.id === row.id)).toBe(false);
		expect(
			overview.payouts.find((target) => target.ref.id === targetId)?.bank,
		).toBe("needs-review");
	});

	it("does not acknowledge duplicate proposed allocations as an exact retry", async () => {
		const db = await createTestDb();
		const made = await account(db);
		await imported(db, made.id, csv("2026-10-01,Deposit,10"));
		const [row] = await bankRows(db, made.id);
		const left = await payout(db, "LEFT", 5),
			right = await payout(db, "RIGHT", 5);
		const input = {
			transactionId: row.id,
			replaces: null,
			parts: [part(left, 500), part(right, 500)],
		};
		expect(await confirmMatch(db, input, actor)).toMatchObject({
			ok: true,
			value: { kind: "matched" },
		});
		expect(
			await confirmMatch(
				db,
				{ ...input, parts: [part(right, 500), part(left, 500)] },
				actor,
			),
		).toMatchObject({ ok: true, value: { kind: "already" } });
		expect(
			await confirmMatch(
				db,
				{ ...input, parts: [part(left, 500), part(left, 500)] },
				actor,
			),
		).toMatchObject({ ok: false });
	});
	it("rejects an unknown explicit account rather than selecting another", async () => {
		const db = await createTestDb();
		const made = await account(db);
		expect((await loadOverview(db, null)).account?.id).toBe(made.id);
		await expect(loadOverview(db, made.id + 100)).rejects.toThrow(
			"doesn't exist",
		);
	});

	it("corrects skipped rows and mapping without replacing retained evidence", async () => {
		const db = await createTestDb();
		const made = await account(db);
		const input = {
			accountId: made.id,
			text: csv("2026-10-01,A,10", "2026-10-02,B,20"),
			fileName: null,
			mapping: MAPPING,
		};
		const first = await commitImport(db, { ...input, skipRows: [2] }, actor);
		if (!first.ok) throw new Error(first.problem);
		expect(
			await commitImport(db, { ...input, skipRows: [] }, actor),
		).toMatchObject({ ok: false });
		const correction = {
			...input,
			mapping: {
				...MAPPING,
				amount: {
					kind: "signed" as const,
					column: "Amount",
					positiveMeans: "out" as const,
				},
			},
			skipRows: [],
			replacesImportId: first.value.importId,
		};
		const fixed = await commitImport(db, correction, actor);
		expect(fixed).toMatchObject({
			ok: true,
			value: { kind: "imported", added: 2 },
		});
		expect(await commitImport(db, correction, actor)).toMatchObject({
			ok: true,
			value: { kind: "already" },
		});
		const rows = await bankRows(db, made.id);
		expect(rows).toHaveLength(3);
		expect(rows[0]).toMatchObject({
			amountCents: 1000,
			voidedBy: "system:script",
		});
		expect(rows[0].voidedAt).not.toBeNull();
		expect(
			rows.filter((row) => row.voidedAt === null).map((row) => row.amountCents),
		).toEqual([-1000, -2000]);
		expect((await loadOverview(db, made.id)).rows).toHaveLength(2);
		expect(await db.select().from(bankImports)).toHaveLength(2);
	});

	it("requires a decision for overlap while allowing a real identical transaction", async () => {
		const db = await createTestDb();
		const made = await account(db);
		await imported(db, made.id, csv("2026-10-01,A,10"));
		const input = {
			accountId: made.id,
			text: csv("2026-10-01,A,10", "2026-10-02,B,20"),
			fileName: null,
			mapping: MAPPING,
			skipRows: [],
		};
		expect(await commitImport(db, input, actor)).toMatchObject({
			ok: false,
			problem: expect.stringContaining("may already"),
		});
		expect(await bankRows(db, made.id)).toHaveLength(1);
		expect(
			await commitImport(db, { ...input, keepRows: [1] }, actor),
		).toMatchObject({ ok: true, value: { added: 2 } });
		expect(await bankRows(db, made.id)).toHaveLength(3);
	});

	it("requires undo before correcting a matched import", async () => {
		const db = await createTestDb();
		const made = await account(db);
		const text = csv("2026-10-01,A,10");
		const first = await imported(db, made.id, text);
		const [row] = await bankRows(db, made.id);
		const targetId = await payout(db, "CORRECT", 10);
		const match = await confirmMatch(
			db,
			{ transactionId: row.id, parts: [part(targetId, 1000)], replaces: null },
			actor,
		);
		if (!match.ok) throw new Error(match.problem);
		const input = {
			accountId: made.id,
			text,
			fileName: null,
			mapping: MAPPING,
			skipRows: [],
			replacesImportId: first.importId,
		};
		expect(await commitImport(db, input, actor)).toMatchObject({
			ok: false,
			problem: expect.stringContaining("Undo"),
		});
		expect(await undoMatch(db, match.value.matchId, actor)).toMatchObject({
			ok: true,
		});
		expect(await commitImport(db, input, actor)).toMatchObject({ ok: true });
	});

	it("uses shop-day boundaries, including a late payout on the upper day", async () => {
		const db = await createTestDb();
		const included = await payout(db, "LATE", 10, {
			depositedAt: new Date("2026-11-02T04:59:59Z"),
		});
		await payout(db, "TOMORROW", 10, {
			depositedAt: new Date("2026-11-02T05:00:00Z"),
		});
		expect(
			(
				await payoutTarget.near(db, {
					currency: "USD",
					from: "2026-11-01",
					to: "2026-11-01",
				})
			).map((row) => row.ref.id),
		).toEqual([included]);
	});

	it("records actor provenance and audit events without writing payouts", async () => {
		const raw = await createTestDb();
		const db = audited(raw);
		await runAs(actor, "banking:integration", async () => {
			const made = await account(db);
			await imported(db, made.id, csv("2026-10-01,A,10"));
			const [row] = await bankRows(db, made.id);
			const targetId = await payout(raw, "AUDIT", 10);
			const [before] = await raw
				.select()
				.from(payouts)
				.where(eq(payouts.id, targetId));
			const match = await confirmMatch(
				db,
				{
					transactionId: row.id,
					parts: [part(targetId, 1000)],
					replaces: null,
				},
				actor,
			);
			if (!match.ok) throw new Error(match.problem);
			await expect(
				raw.update(bankMatches).set({
					undoneAt: new Date(),
					undoneBy: "system:script",
					matchedBy: "someone else",
				}),
			).rejects.toThrow();
			await undoMatch(db, match.value.matchId, actor);
			expect(
				await raw.select().from(payouts).where(eq(payouts.id, targetId)),
			).toEqual([before]);
		});
		const [made] = await raw.select().from(bankAccounts);
		expect(made.createdBy).toBe("system:script");
		const [importedRow] = await raw.select().from(bankImports);
		expect(importedRow.importedBy).toBe("system:script");
		const [match] = await raw.select().from(bankMatches);
		expect(match).toMatchObject({
			matchedBy: "system:script",
			undoneBy: "system:script",
		});
		const events = await raw
			.select()
			.from(auditEvents)
			.where(sql`${auditEvents.tableName} like 'bank_%'`);
		expect(events.length).toBeGreaterThan(5);
		expect(
			events.every(
				(event) =>
					event.principal === "system" && event.systemName === "script",
			),
		).toBe(true);
		await expect(
			raw.execute(sql`truncate bank_import_rows cascade`),
		).rejects.toThrow();
		expect(
			await raw
				.select()
				.from(bankTransactions)
				.where(and(isNull(bankTransactions.voidedAt))),
		).toHaveLength(1);
	});
});
