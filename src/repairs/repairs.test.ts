import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, test } from "vitest";
import type { Db } from "#/db/client";
import { repairParts, repairs } from "#/db/repair-schema";
import * as schema from "#/db/schema";
import { createProduct, createTestDb } from "#/test/db";
import { REPAIR_KEY } from "./draft-lines";
import { refreshDrafts } from "./draft-sync";
import { fakeShopify } from "./fake-shopify.fixtures";
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
	const make = () => createRepair(db, { customer, tool: "TapeTech taper" });
	const row = async (id: number) =>
		(await db.select().from(repairs).where(eq(repairs.id, id)))[0];

	test("the first charge makes the draft, and the last deletes it", async () => {
		const id = await make();
		expect(id).toBe(1001);
		expect((await row(id)).draftOrderId).toBeNull();
		const labor = await addLabor(db, id, 195, "rebuilt the pump");
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
		await addLabor(db, id, 30);
		const draftId = (await row(id)).draftOrderId ?? "";
		shop.addAtRegister(draftId, "Sanding pole", "24.99");
		await setPart(db, id, blade, 2);
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
		await addLabor(db, id, 60);
		shop.pay((await row(id)).draftOrderId ?? "");
		await expect(addLabor(db, id, 15)).rejects.toThrow(
			/paid in Shopify as #1234/,
		);
		expect(await row(id)).toMatchObject({
			status: "picked_up",
			orderName: "#1234",
			draftOrderId: null,
		});
		await expect(moveRepair(db, id, "ready")).rejects.toThrow(/paid/);
	});

	test("refreshing picks up paid drafts once", async () => {
		const id = await make();
		await addLabor(db, id, 60);
		shop.pay((await row(id)).draftOrderId ?? "");
		expect(await refreshDrafts(db)).toBe(1);
		expect(await refreshDrafts(db)).toBe(0);
		expect((await row(id)).status).toBe("picked_up");
	});

	test("pickup by hand only with nothing to charge", async () => {
		const id = await make();
		await addLabor(db, id, 15);
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
		await expect(setPart(db, id, loose, 1)).rejects.toThrow(/LOOSE/);
		expect(await db.select().from(repairParts)).toEqual([]);
		expect(shop.calls).toEqual([]);
	});

	test("time goes in 15-minute steps", async () => {
		const id = await make();
		await expect(addLabor(db, id, 20)).rejects.toThrow(/15-minute/);
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
