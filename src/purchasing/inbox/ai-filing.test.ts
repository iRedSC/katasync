import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, test, vi } from "vitest";
import type { Filing } from "#/ai/agents";
import type { Agent, runAgent } from "#/ai/harness";
import type { Db } from "#/db/client";
import * as schema from "#/db/schema";
import {
	openFlagsOf,
	raiseFlag,
	reopenFlag,
	resolveFlag,
} from "#/purchasing/flags";
import { createPurchasingDb } from "#/purchasing/purchasing.fixtures";
import { fileWithAi, takeSuggestion, undoFiling } from "./ai-filing";
import { fileEmail } from "./ingest";

// The agent: calls its flag tool with each of flags, then answers as told,
// keeping what it was asked and what its tools said.
function agent(answer: Partial<Filing>, flags: Record<string, unknown>[] = []) {
	const asked: string[] = [];
	const said: unknown[] = [];
	const run = vi.fn(async (a: Agent<Filing>, input: string) => {
		asked.push(input);
		const flag = a.tools?.find((t) => t.name === "flag");
		for (const f of flags)
			said.push(await flag?.run(f).catch((e: Error) => e.message));
		return {
			po: null,
			sure: true,
			reason: "Names it",
			tracking: [],
			...answer,
		};
	}) as unknown as typeof runAgent;
	return { run, asked, said };
}

describe("the AI filing emails", () => {
	let db: Db;
	let po: number;
	let blade: number;
	let knife: number;
	let email: number;
	let seeded: { supplierId: number; locationId: number };

	beforeEach(async () => {
		vi.stubEnv("SHIPPO_API_KEY", "");
		const made0 = await createPurchasingDb();
		db = made0.db;
		seeded = { supplierId: made0.canam, locationId: made0.warehouse };
		await db
			.update(schema.suppliers)
			.set({ email: "orders@canam.com" })
			.where(eq(schema.suppliers.id, made0.canam));
		const made = await db
			.insert(schema.products)
			.values([
				{ sku: "BLADE", name: "Blade", kind: "simple" },
				{ sku: "KNIFE", name: "Knife", kind: "simple" },
			])
			.returning();
		[blade, knife] = made.map((p) => p.id);
		[{ id: po }] = await db
			.insert(schema.purchaseOrders)
			.values({
				...seeded,
				status: "sent",
				sentAt: new Date(),
			})
			.returning();
		await db.insert(schema.purchaseOrderLines).values([
			{
				purchaseOrderId: po,
				productId: blade,
				supplierCount: 1,
				unit: "CASE",
				packSize: 12,
				quantity: 2,
				unitCost: 40,
				sentQuantity: 2,
				sentUnitCost: 40,
			},
			{
				purchaseOrderId: po,
				productId: knife,
				supplierCount: 1,
				quantity: 5,
				unitCost: 10,
				sentQuantity: 5,
				sentUnitCost: 10,
			},
		]);
		[{ id: email }] = await db
			.insert(schema.poEmails)
			.values({
				messageId: "<m1@canam.com>",
				fromAddress: "rep@canam.com",
				recipients: ["purchasing@eastcoastdrywall.com"],
				subject: "Your order shipped",
				body: `Order ${po} shipped UPS 1Z999AA10123456784. Knives back-ordered.`,
				receivedAt: new Date(),
			})
			.returning();
	});

	const ai = async () =>
		(
			await db
				.select()
				.from(schema.poEmailAi)
				.where(eq(schema.poEmailAi.emailId, email))
		)[0];
	const theEmail = async () =>
		(
			await db
				.select()
				.from(schema.poEmails)
				.where(eq(schema.poEmails.id, email))
		)[0];
	const lines = async () =>
		db
			.select()
			.from(schema.purchaseOrderLines)
			.orderBy(schema.purchaseOrderLines.id);

	const flags = () =>
		db.select().from(schema.poFlags).orderBy(schema.poFlags.id);

	test("files it, follows tracking, flags what differs, changes no line", async () => {
		const { run, asked, said } = agent(
			{ po, tracking: [{ number: "1Z999AA10123456784" }] },
			[
				{
					po,
					kind: "price",
					sku: "blade",
					value: 44,
					note: "Invoice $44/case",
				},
				{ po, kind: "back_order", sku: "KNIFE", note: "Knives back-ordered" },
				{ po, kind: "price", sku: "NOPE", value: 1, note: "x" },
				{ po: 99999, kind: "note", note: "x" },
			],
		);
		expect(await fileWithAi(db, { run })).toMatchObject({ filed: 1 });
		// It read the email and the PO, lines and all.
		expect(asked[0]).toContain("Knives back-ordered");
		expect(JSON.parse(asked[0]).likelyPos[0].id).toBe(po);
		// A flag the PO can't take tells the agent why, at once.
		expect(said).toEqual([
			"Flagged",
			"Flagged",
			`NOPE isn't on PO ${po}`,
			"PO 99999 isn't one an email can go on",
		]);
		expect(await theEmail()).toMatchObject({
			purchaseOrderId: po,
			matchedBy: "ai",
		});
		const [b, k] = await lines();
		expect(b.unitCost).toBe(40);
		expect(k.backOrderedAt).toBeNull();
		expect(await flags()).toMatchObject([
			{ kind: "price", productId: blade, value: 44, emailId: email, by: "ai" },
			{ kind: "back_order", productId: knife, value: null },
		]);
		expect((await ai()).applied).toEqual({
			tracking: ["1Z999AA10123456784"],
			skipped: [],
		});
		// Settled: a second run leaves it alone.
		expect(await fileWithAi(db, { run })).toMatchObject({ filed: 0 });
	});

	test("unsure, it only suggests; taking it files and flags", async () => {
		const { run } = agent({ po, sure: false }, [
			{ po, kind: "price", sku: "KNIFE", value: 11, note: "Now $11" },
		]);
		expect(await fileWithAi(db, { run })).toMatchObject({ suggested: 1 });
		expect((await theEmail()).purchaseOrderId).toBeNull();
		expect(await flags()).toEqual([]);
		await takeSuggestion(db, email);
		expect(await theEmail()).toMatchObject({
			purchaseOrderId: po,
			matchedBy: "staff",
		});
		expect(await flags()).toMatchObject([{ kind: "price", value: 11 }]);
		await expect(takeSuggestion(db, email)).rejects.toThrow(/no suggestion/);
	});

	test("a PO that isn't a sent one is no match", async () => {
		const { run } = agent({ po: 99999 });
		expect(await fileWithAi(db, { run })).toMatchObject({ unmatched: 1 });
		expect(await ai()).toMatchObject({
			state: "unmatched",
			purchaseOrderId: null,
		});
		expect((await theEmail()).purchaseOrderId).toBeNull();
	});

	test("never takes an email staff set aside while it read", async () => {
		const run = vi.fn(async () => {
			await db
				.update(schema.poEmails)
				.set({ setAsideAt: new Date() })
				.where(eq(schema.poEmails.id, email));
			return { po, sure: true, reason: "x", tracking: [] };
		}) as unknown as typeof runAgent;
		await fileWithAi(db, { run });
		expect((await theEmail()).purchaseOrderId).toBeNull();
		expect(await ai()).toMatchObject({
			state: "unmatched",
			reason: "Someone set it aside first",
		});
	});

	test("a failure is tried again later, not at once", async () => {
		const run = vi.fn(async () => {
			throw new Error("Proxy down");
		}) as unknown as typeof runAgent;
		expect((await fileWithAi(db, { run })).problems).toEqual([
			`Email ${email}: Proxy down`,
		]);
		expect(await ai()).toMatchObject({ state: "failed", error: "Proxy down" });
		await fileWithAi(db, { run });
		expect(run).toHaveBeenCalledTimes(1);
	});

	test("undo takes it off with its tracking and open flags, keeps settled ones", async () => {
		const { run } = agent(
			{ po, tracking: [{ number: "1Z999AA10123456784" }] },
			[
				{ po, kind: "price", sku: "BLADE", value: 44, note: "a" },
				{ po, kind: "back_order", sku: "KNIFE", note: "b" },
			],
		);
		await fileWithAi(db, { run });
		const [price] = await flags();
		await resolveFlag(db, { id: price.id, apply: false });
		expect(await undoFiling(db, email)).toEqual({
			purchaseOrderId: po,
			kept: ["BLADE, dismissed"],
		});
		expect(await theEmail()).toMatchObject({ purchaseOrderId: null });
		expect(await db.select().from(schema.purchaseOrderTracking)).toEqual([]);
		expect(await flags()).toMatchObject([{ id: price.id }]);
		expect((await ai()).state).toBe("undone");
		// Undone stays undone: no run files it again.
		expect(await fileWithAi(db, { run })).toMatchObject({ filed: 0 });
		await expect(undoFiling(db, email)).rejects.toThrow(/nothing filed/);
	});

	test("undo leaves an email someone moved", async () => {
		const [{ id: other }] = await db
			.insert(schema.purchaseOrders)
			.values({ ...seeded, status: "sent", sentAt: new Date() })
			.returning();
		await fileWithAi(db, { run: agent({ po }).run });
		await fileEmail(db, {
			emailId: email,
			purchaseOrderId: other,
			by: "staff",
		});
		expect((await undoFiling(db, email)).kept).toEqual([
			"the email, moved since",
		]);
		expect((await theEmail()).purchaseOrderId).toBe(other);
	});
});

describe("flags", () => {
	let db: Db;
	let po: number;
	beforeEach(async () => {
		const made = await createPurchasingDb();
		db = made.db;
		const [p] = await db
			.insert(schema.products)
			.values({ sku: "BLADE", name: "Blade", kind: "simple" })
			.returning();
		[{ id: po }] = await db
			.insert(schema.purchaseOrders)
			.values({
				supplierId: made.canam,
				locationId: made.warehouse,
				status: "sent",
				sentAt: new Date(),
			})
			.returning();
		await db.insert(schema.purchaseOrderLines).values({
			purchaseOrderId: po,
			productId: p.id,
			supplierCount: 1,
			quantity: 5,
			unitCost: 10,
			sentQuantity: 5,
			sentUnitCost: 10,
		});
	});
	const line = async () =>
		(await db.select().from(schema.purchaseOrderLines))[0];
	const raise = (flag: Parameters<typeof raiseFlag>[1]["flag"]) =>
		raiseFlag(db, { purchaseOrderId: po, by: "claude", flag });

	test("apply makes the change; reopen sets it back", async () => {
		const f = await raise({
			kind: "price",
			sku: "BLADE",
			value: 12,
			note: "x",
		});
		expect(await openFlagsOf(db, po)).toMatchObject([
			{ sku: "BLADE", unitCost: 10, value: 12 },
		]);
		await resolveFlag(db, { id: f.id, apply: true });
		expect((await line()).unitCost).toBe(12);
		expect(await openFlagsOf(db, po)).toEqual([]);
		await expect(resolveFlag(db, { id: f.id, apply: true })).rejects.toThrow(
			/applied already/,
		);
		await reopenFlag(db, f.id);
		expect((await line()).unitCost).toBe(10);
		expect(await openFlagsOf(db, po)).toHaveLength(1);
	});

	test("quantity and back-order apply too", async () => {
		const q = await raise({
			kind: "quantity",
			sku: "BLADE",
			value: 4,
			note: "x",
		});
		const b = await raise({ kind: "back_order", sku: "BLADE", note: "x" });
		await resolveFlag(db, { id: q.id, apply: true });
		await resolveFlag(db, { id: b.id, apply: true });
		expect(await line()).toMatchObject({ quantity: 4 });
		expect((await line()).backOrderedAt).not.toBeNull();
		await reopenFlag(db, b.id);
		expect((await line()).backOrderedAt).toBeNull();
	});

	test("a newer flag of a kind replaces the open one; notes add up", async () => {
		await raise({ kind: "price", sku: "BLADE", value: 12, note: "x" });
		await raise({ kind: "price", sku: "blade", value: 13, note: "y" });
		await raise({ kind: "note", sku: null, note: "Substituting" });
		await raise({ kind: "note", sku: null, note: "Call us" });
		expect(await openFlagsOf(db, po)).toMatchObject([
			{ kind: "price", value: 13, note: "y" },
			{ kind: "note" },
			{ kind: "note" },
		]);
	});

	test("refuses a flag the PO can't take, and a reopen over a newer change", async () => {
		await expect(
			raise({ kind: "back_order", sku: "", note: "x" }),
		).rejects.toThrow(/needs the line's sku/);
		await expect(
			raise({ kind: "quantity", sku: "BLADE", value: 1.5, note: "x" }),
		).rejects.toThrow(/can't be 1.5/);
		const n = await raise({ kind: "note", sku: null, note: "x" });
		await expect(resolveFlag(db, { id: n.id, apply: true })).rejects.toThrow(
			/nothing to apply/,
		);
		const f = await raise({
			kind: "price",
			sku: "BLADE",
			value: 12,
			note: "x",
		});
		await resolveFlag(db, { id: f.id, apply: true });
		await db.update(schema.purchaseOrderLines).set({ unitCost: 14 });
		await expect(reopenFlag(db, f.id)).rejects.toThrow(/changed since/);
		expect((await line()).unitCost).toBe(14);
	});
});
