import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, test } from "vitest";
import type { Db } from "#/db/client";
import { repairParts, repairs, repairTools } from "#/db/repair-schema";
import * as schema from "#/db/schema";
import { createProduct, createTestDb } from "#/test/db";
import {
	LABOR as LABOR_KEY,
	REPAIR_KEY,
	TOOL_KEY,
	TOOL_LABEL,
} from "./draft-lines";
import { refreshDrafts } from "./draft-sync";
import { fakeShopify } from "./fake-shopify.fixtures";
import { breakdown, repairInvoice, share } from "./invoice";
import { formatMinutes, splitLabor, variantMinutes } from "./labor";
import { repairNumber } from "./number";
import { addPerson, removePerson } from "./people";
import {
	addLabor,
	createRepair,
	editRepair,
	moveRepair,
	RepairError,
	removeLabor,
	setPart,
} from "./repairs";
import { refuseMove } from "./status";
import { addTool, editTool, removeTool, restoreTool } from "./tools";

const variants = [15, 30, 45, 60, 75, 90, 105, 120].map((minutes) => ({
	variantId: `v${minutes}`,
	minutes,
	price: (minutes / 60) * 55,
}));

describe("labor", () => {
	test("reads Shopify's variant titles", () => {
		expect(
			["15m", "1h", "1h 15m", "2h", "Default Title"].map(variantMinutes),
		).toEqual([15, 60, 75, 120, null]);
		expect(formatMinutes(195)).toBe("3h 15m");
	});

	test("bills time as the fewest variants adding up exactly", () => {
		expect(splitLabor(195, variants)?.map((v) => v.minutes)).toEqual([120, 75]);
		expect(splitLabor(480, variants)?.map((v) => v.minutes)).toEqual([
			120, 120, 120, 120,
		]);
		expect(splitLabor(10, variants)).toBeNull();
		expect(splitLabor(0, variants)).toBeNull();
	});

	test("an invoice lists every line of ours, whatever Shopify lost", () => {
		const line = (key: string, variantId: string | null, total: number) => ({
			title: key,
			quantity: 1,
			variantId,
			customAttributes: [
				{ key: REPAIR_KEY, value: "R1" },
				{ key: TOOL_KEY, value: key },
			],
			total,
		});
		const { groups } = breakdown({
			tools: [{ id: 1, tool: "Taper", serial: null, problem: "" }],
			labor: [{ toolId: 1, minutes: 60, note: "" }],
			parts: [],
			variantOf: new Map(),
			laborVariants: new Set(),
			bill: {
				name: "#1",
				ordered: true,
				subtotal: 65,
				shipping: 0,
				tax: 0,
				total: 65,
				due: 0,
				refunded: 0,
				// Its labor variant deleted since; a line for a tool taken off.
				lines: [line(LABOR_KEY, null, 55), line("99", "gid://x/1", 10)],
			},
		});
		expect(groups.map((g) => [g.tool?.tool ?? null, g.subtotal])).toEqual([
			["Taper", 55],
			[null, 10],
		]);
	});

	test("shares a charge by minutes in cents that add back up", () => {
		expect(share(55, [45, 15, 0])).toEqual([41.25, 13.75, 0]);
		expect(share(10, [1, 1, 1])).toEqual([3.34, 3.33, 3.33]);
		expect(share(10, [0, 0])).toEqual([0, 0]);
	});
});

describe("moving", () => {
	const at = (
		status: Parameters<typeof refuseMove>[0]["status"],
		hasDraft = false,
		paid = false,
	) => ({
		status,
		bench: false,
		hasDraft,
		paid,
	});
	test("the board moves freely; pickup waits for payment", () => {
		expect(refuseMove(at("received"), "ready")).toBeNull();
		expect(refuseMove(at("ready", true), "picked_up")).toMatch(/Pay/);
		expect(refuseMove(at("ready"), "picked_up")).toBeNull();
		expect(refuseMove(at("picked_up", false, true), "ready")).toMatch(/paid/);
		expect(refuseMove(at("picked_up"), "ready")).toBeNull();
		expect(refuseMove(at("cancelled"), "picked_up")).toMatch(/Restore/);
	});
});

describe("repairs on draft orders", () => {
	let db: Db;
	let shop: ReturnType<typeof fakeShopify>;
	let blade: number;
	beforeEach(async () => {
		db = await createTestDb();
		shop = fakeShopify();
		const [store] = await db
			.insert(schema.stores)
			.values({ channel: "shopify", name: "Shopify" })
			.returning();
		blade = await createProduct(db, "BLADE", "simple");
		await db.insert(schema.listings).values({
			storeId: store.id,
			externalId: "gid://shopify/ProductVariant/BLADE",
			title: "Blade",
			productId: blade,
			status: "ACTIVE",
		});
	});

	const customer = {
		id: "gid://shopify/Customer/1",
		name: "Pat Lee",
		phone: "+15555550100",
		email: null,
	};
	const make = () =>
		createRepair(db, { customer, tools: [{ tool: "TapeTech taper" }] });
	const row = async (id: number) =>
		(await db.select().from(repairs).where(eq(repairs.id, id)))[0];
	const firstTool = async (id: number) =>
		(
			await db
				.select({ id: repairTools.id })
				.from(repairTools)
				.where(eq(repairTools.repairId, id))
		)[0].id;
	const draftOf = async (id: number) =>
		shop.drafts.get((await row(id)).draftOrderId ?? "");

	test("the first charge makes the draft, and the last deletes it", async () => {
		const id = await make();
		expect(id).toBe(1001);
		expect((await row(id)).draftOrderId).toBeNull();
		const labor = await addLabor(db, id, {
			toolId: await firstTool(id),
			minutes: 195,
			note: "rebuilt the pump",
		});
		const { draftOrderId } = await row(id);
		const draft = shop.drafts.get(draftOrderId ?? "");
		expect(draft?.customerId).toBe(customer.id);
		expect(draft?.tags).toContain("R1001");
		expect(draft?.lines.map((l) => [l.variant?.id, l.quantity])).toEqual([
			["gid://shopify/ProductVariant/L120", 1],
			["gid://shopify/ProductVariant/L75", 1],
		]);
		expect(
			draft?.lines.every((l) =>
				l.customAttributes.some((a) => a.key === REPAIR_KEY),
			),
		).toBe(true);
		await removeLabor(db, id, labor);
		expect(shop.drafts.size).toBe(0);
		expect((await row(id)).draftOrderId).toBeNull();
	});

	test("keeps what was added at the register", async () => {
		const id = await make();
		const toolId = await firstTool(id);
		await addLabor(db, id, { toolId, minutes: 30 });
		const draftId = (await row(id)).draftOrderId ?? "";
		shop.addAtRegister(draftId, "Sanding pole", "24.99");
		await setPart(db, id, { toolId, productId: blade, quantity: 2 });
		const titles = () => shop.drafts.get(draftId)?.lines.map((l) => l.title);
		expect(titles()).toEqual([
			"Sanding pole",
			"Item gid://shopify/ProductVariant/L30",
			"Item gid://shopify/ProductVariant/BLADE",
		]);
		// Cancelling takes the repair's charges off, leaving the pole's sale.
		await moveRepair(db, id, "cancelled");
		expect(titles()).toEqual(["Sanding pole"]);
		expect(await row(id)).toMatchObject({
			status: "cancelled",
			draftOrderId: null,
		});
		// Restoring puts them on a draft again.
		await moveRepair(db, id, "received");
		const again = shop.drafts.get((await row(id)).draftOrderId ?? "");
		expect(again?.lines).toHaveLength(2);
	});

	test("a draft paid meanwhile moves the repair and refuses the change", async () => {
		const id = await make();
		await addLabor(db, id, { toolId: null, minutes: 60 });
		shop.pay((await row(id)).draftOrderId ?? "");
		await expect(
			addLabor(db, id, { toolId: null, minutes: 15 }),
		).rejects.toThrow(/paid in Shopify as #1234/);
		expect(await row(id)).toMatchObject({
			status: "picked_up",
			orderName: "#1234",
			draftOrderId: null,
		});
		await expect(moveRepair(db, id, "ready")).rejects.toThrow(/paid/);
	});

	test("refreshing picks up paid drafts once", async () => {
		const id = await make();
		await addLabor(db, id, { toolId: null, minutes: 60 });
		shop.pay((await row(id)).draftOrderId ?? "");
		expect(await refreshDrafts(db)).toBe(1);
		expect(await refreshDrafts(db)).toBe(0);
		expect((await row(id)).status).toBe("picked_up");
	});

	test("pickup by hand only with nothing to charge", async () => {
		const id = await make();
		await addLabor(db, id, { toolId: null, minutes: 15 });
		await expect(moveRepair(db, id, "picked_up")).rejects.toThrow(RepairError);
		const other = await make();
		await moveRepair(db, other, "picked_up");
		expect((await row(other)).status).toBe("picked_up");
		await moveRepair(db, other, "ready");
		expect((await row(other)).status).toBe("ready");
	});

	test("a part Shopify doesn't sell changes nothing", async () => {
		const id = await make();
		const loose = await createProduct(db, "LOOSE", "simple");
		await expect(
			setPart(db, id, { toolId: null, productId: loose, quantity: 1 }),
		).rejects.toThrow(/LOOSE/);
		expect(await db.select().from(repairParts)).toEqual([]);
		expect(shop.calls).toEqual([]);
	});

	test("time goes in 15-minute steps", async () => {
		const id = await make();
		await expect(
			addLabor(db, id, { toolId: null, minutes: 20 }),
		).rejects.toThrow(/15-minute/);
	});

	test("each tool's parts are its own lines, and its time is billed with the rest", async () => {
		const id = await make();
		const taper = await firstTool(id);
		const box = await addTool(db, id, { tool: "Flat box", serial: "B7" });
		await addLabor(db, id, { toolId: taper, minutes: 60 });
		await addLabor(db, id, { toolId: box, minutes: 60 });
		// The same part on a tool and on the order stays two lines.
		await setPart(db, id, { toolId: box, productId: blade, quantity: 1 });
		await setPart(db, id, { toolId: null, productId: blade, quantity: 3 });
		await setPart(db, id, { toolId: null, productId: blade, quantity: 2 });
		const lines = (await draftOf(id))?.lines ?? [];
		const attr = (l: (typeof lines)[number], key: string) =>
			l.customAttributes.find((a) => a.key === key)?.value;
		expect(
			lines.map((l) => [
				attr(l, TOOL_KEY),
				attr(l, TOOL_LABEL),
				l.variant?.id.split("/").pop(),
				l.quantity,
			]),
		).toEqual([
			[LABOR_KEY, "TapeTech taper 1h, Flat box (serial B7) 1h", "L120", 1],
			[String(box), "Flat box (serial B7)", "BLADE", 1],
			["other", undefined, "BLADE", 2],
		]);
		expect(new Set(lines.map((l) => l.uuid)).size).toBe(3);
		expect((await draftOf(id))?.note).toBe(
			"Repair R1001\nTapeTech taper\nFlat box (serial B7)",
		);

		// Renaming a tool renames its lines.
		await editTool(db, id, box, { tool: "Corner box" });
		expect((await draftOf(id))?.lines.map((l) => attr(l, TOOL_LABEL))).toEqual([
			"TapeTech taper 1h, Corner box (serial B7) 1h",
			"Corner box (serial B7)",
			undefined,
		]);

		// Taking one off takes its charges; putting it back returns them.
		const removed = await removeTool(db, id, box);
		expect(removed).toMatchObject({
			tool: "Corner box",
			labor: [{ minutes: 60 }],
			parts: [{ productId: blade, quantity: 1 }],
		});
		expect((await draftOf(id))?.lines).toHaveLength(2);
		const back = await restoreTool(db, id, removed);
		expect(
			(await draftOf(id))?.lines.filter(
				(l) => attr(l, TOOL_KEY) === String(back),
			),
		).toHaveLength(1);

		// A repair keeps one tool, and only its own.
		await removeTool(db, id, back);
		await expect(removeTool(db, id, taper)).rejects.toThrow(/at least one/);
		const other = await make();
		await expect(
			addLabor(db, other, { toolId: taper, minutes: 15 }),
		).rejects.toThrow(/isn't on this repair/);
	});

	test("the invoice prices each tool as Shopify charges it", async () => {
		const id = await make();
		const taper = await firstTool(id);
		const box = await addTool(db, id, { tool: "Flat box", problem: "Sticks" });
		await addLabor(db, id, { toolId: taper, minutes: 30, note: "Cleaned" });
		await addLabor(db, id, { toolId: taper, minutes: 30, note: "New seal" });
		await addLabor(db, id, { toolId: box, minutes: 15, note: "Oiled" });
		await setPart(db, id, { toolId: box, productId: blade, quantity: 1 });
		await setPart(db, id, { toolId: null, productId: blade, quantity: 2 });
		shop.addAtRegister((await row(id)).draftOrderId ?? "", "Pole", "24.99");
		const shape = (i: NonNullable<Awaited<ReturnType<typeof repairInvoice>>>) =>
			i.groups.map((g) => ({
				tool: g.tool?.tool ?? null,
				labor: g.labor.map((l) => l.note),
				laborTotal: g.laborTotal,
				parts: g.parts.map((p) => [p.sku, p.quantity, p.total]),
				subtotal: g.subtotal,
			}));
		const expected = [
			{
				tool: "TapeTech taper",
				labor: ["Cleaned", "New seal"],
				// Its 1h of the one 1h 15m line, at Shopify's price.
				laborTotal: 55,
				parts: [],
				subtotal: 55,
			},
			{
				tool: "Flat box",
				labor: ["Oiled"],
				laborTotal: 13.75,
				parts: [["BLADE", 1, 10]],
				subtotal: 23.75,
			},
			{
				tool: null,
				labor: [],
				laborTotal: 0,
				parts: [["BLADE", 2, 20]],
				subtotal: 20,
			},
		];
		const open = await repairInvoice(db, id);
		expect(open && shape(open)).toEqual(expected);
		expect(open).toMatchObject({
			bill: { ordered: false, subtotal: 123.74, due: 123.74 },
			added: [{ title: "Pole", total: 24.99 }],
			adjustment: 0,
			unpriced: null,
		});
		// Once paid, the same, off the order.
		shop.pay((await row(id)).draftOrderId ?? "");
		await refreshDrafts(db);
		const paid = await repairInvoice(db, id);
		expect(paid && shape(paid)).toEqual(expected);
		expect(paid?.bill).toMatchObject({ ordered: true, name: "#1234", due: 0 });
		expect(paid?.groups.every((g) => g.extra.length === 0)).toBe(true);
	});

	test("a removed person can't be given a repair", async () => {
		const id = await make();
		const sam = await addPerson(db, "Sam", true);
		await editRepair(db, id, { technicianId: sam });
		expect((await row(id)).technicianId).toBe(sam);
		await removePerson(db, sam);
		await expect(editRepair(db, id, { technicianId: sam })).rejects.toThrow(
			/isn't in Settings/,
		);
		await expect(addPerson(db, "sam", false)).resolves.toBeTypeOf("number");
	});
});

test("finds a repair's number however it's typed or scanned", () => {
	expect(
		[
			"R1001",
			" r1002 ",
			"1003",
			"https://katasync.example/repairs/1004",
			"Pat",
			"R12",
		].map(repairNumber),
	).toEqual([1001, 1002, 1003, 1004, null, null]);
});
