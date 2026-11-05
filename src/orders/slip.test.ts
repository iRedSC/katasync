import { eq } from "drizzle-orm";
import { describe, expect, test, vi } from "vitest";
import * as schema from "#/db/schema";
import { voidDispatch } from "#/shipping/handoff";
import { LabelRefused } from "#/shipping/label-attempt-state";
import {
	buy,
	buying,
	db,
	freshOrder,
	handOff,
	lineId,
	marketplace,
	openReads,
	orderId,
	shipOutside,
	shopify,
	sync,
} from "#/shipping/several-shipments.fixtures";
import { slipsOf } from "./slip";

freshOrder();

const slip = async () =>
	(await slipsOf(db, [{ id: orderId, needsPacking: true }], openReads)).get(
		orderId,
	);

describe("slipsOf", () => {
	test("a reprint lists the box as bought, whatever a sync changes since", async () => {
		const bought = await buy([{ orderLineId: lineId, quantity: 2 }]);
		expect(bought.failed).toBeNull();
		// The marketplace edits the wrench down to 0 and adds a knife.
		await db
			.update(schema.orderLines)
			.set({ quantity: 0, title: "Wrench (renamed)", sku: "OTHER" })
			.where(eq(schema.orderLines.id, lineId));
		await db.insert(schema.orderLines).values({
			orderId,
			externalId: "line-knife",
			sku: "KNIFE",
			title: "Knife",
			quantity: 1,
			shippedQuantity: 0,
			unitPrice: 5,
		});

		const printed = await slip();
		expect(printed?.items).toEqual([
			// The knife is sold but wasn't bought into this box.
			expect.objectContaining({
				sku: "KNIFE",
				toPack: null,
				sold: { quantity: 1, unitPrice: 5 },
			}),
			expect.objectContaining({
				sku: "WRENCH",
				name: "Wrench",
				toPack: 2,
				sold: null,
			}),
		]);
		// The money is the order's as it is now.
		expect(printed?.subtotal).toBe(5);
	});

	test("a box holding part of the order still prices every line", async () => {
		await db
			.update(schema.orderLines)
			.set({ quantity: 1 })
			.where(eq(schema.orderLines.id, lineId));
		marketplace.open.set("line-1", 1);
		await db.insert(schema.orderLines).values({
			orderId,
			externalId: "line-b",
			sku: "BLADE",
			title: "Blade",
			quantity: 1,
			shippedQuantity: 0,
			unitPrice: 20,
		});
		marketplace.open.set("line-b", 1);
		const bought = await buy([{ orderLineId: lineId, quantity: 0 }]);
		expect(bought.failed).toBeNull();

		const printed = await slip();
		expect(printed?.items).toEqual([
			expect.objectContaining({
				sku: "WRENCH",
				toPack: null,
				sold: { quantity: 1, unitPrice: 10 },
			}),
			expect.objectContaining({
				sku: "BLADE",
				toPack: 1,
				sold: { quantity: 1, unitPrice: 20 },
			}),
		]);
		const priced = (printed?.items ?? []).reduce(
			(s, l) => s + (l.sold ? l.sold.quantity * l.sold.unitPrice : 0),
			0,
		);
		expect(priced).toBe(printed?.subtotal);
		expect(priced).toBe(30);
	});

	test("once part is handed off, the slip packs what the marketplace has open", async () => {
		await buy([{ orderLineId: lineId, quantity: 2 }]);
		expect((await slip())?.items.map((l) => l.toPack)).toEqual([2]);
		await handOff((await db.select().from(schema.dispatches))[0].id);
		// The synced count still says none shipped; Shopify says 1 is open.
		expect((await slip())?.items).toEqual([
			expect.objectContaining({
				toPack: 1,
				sold: { quantity: 3, unitPrice: 10 },
			}),
		]);
	});

	test("a part handed off whose marketplace can't be read packs an unknown count", async () => {
		await buy([{ orderLineId: lineId, quantity: 2 }]);
		await handOff((await db.select().from(schema.dispatches))[0].id);
		marketplace.failing = true;
		vi.spyOn(console, "error").mockImplementation(() => {});
		const printed = await slip();
		expect(printed?.items).toEqual([
			expect.objectContaining({
				toPack: "unknown",
				sold: { quantity: 3, unitPrice: 10 },
			}),
		]);
		expect(printed?.subtotal).toBe(30);
	});

	test("after a handoff is voided, the slip packs what's open again, not the synced count", async () => {
		await buy([{ orderLineId: lineId, quantity: 1 }]);
		const [{ id }] = await db.select().from(schema.dispatches);
		await handOff(id);
		await sync(1);
		await voidDispatch(db, id, shopify());
		// Shopify shows all 3 open again; the synced count still says 1 shipped.
		expect((await slip())?.items.map((l) => l.toPack)).toEqual([3]);
		marketplace.failing = true;
		vi.spyOn(console, "error").mockImplementation(() => {});
		expect((await slip())?.items.map((l) => l.toPack)).toEqual(["unknown"]);
	});

	test("an order whose only box was voided unsent is read live", async () => {
		await buy([{ orderLineId: lineId, quantity: 1 }]);
		const [{ id }] = await db.select().from(schema.dispatches);
		await voidDispatch(db, id, shopify());
		// Shipped from Shopify's admin since; the sync hasn't caught up.
		shipOutside(1);
		expect((await slip())?.items.map((l) => l.toPack)).toEqual([2]);
		expect(marketplace.reads).toBeGreaterThan(0);
	});

	test("an order whose first purchase was refused is read live", async () => {
		vi.mocked(buying.buyLabel).mockImplementationOnce(async () => {
			throw new LabelRefused("bad address");
		});
		await expect(buy([{ orderLineId: lineId, quantity: 1 }])).rejects.toThrow(
			"bad address",
		);
		// Shipped from Shopify's admin since; the sync hasn't caught up.
		shipOutside(1);
		expect((await slip())?.items.map((l) => l.toPack)).toEqual([2]);
		marketplace.failing = true;
		vi.spyOn(console, "error").mockImplementation(() => {});
		expect((await slip())?.items.map((l) => l.toPack)).toEqual(["unknown"]);
	});

	test("an order katasync hasn't handed any of off isn't read live", async () => {
		await sync(1);
		expect((await slip())?.items.map((l) => l.toPack)).toEqual([2]);
		expect(marketplace.reads).toBe(0);
		// A box bought but not handed off prints as bought, unread too.
		await buy([{ orderLineId: lineId, quantity: 1 }]);
		const reads = marketplace.reads;
		expect((await slip())?.items.map((l) => l.toPack)).toEqual([1]);
		expect(marketplace.reads).toBe(reads);
	});
});
