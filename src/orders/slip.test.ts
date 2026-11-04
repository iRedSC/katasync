import { eq } from "drizzle-orm";
import { describe, expect, test } from "vitest";
import * as schema from "#/db/schema";
import {
	buy,
	db,
	freshOrder,
	handOff,
	lineId,
	orderId,
} from "#/shipping/several-shipments.fixtures";
import { slipsOf } from "./slip";

freshOrder();

const slip = async () =>
	(await slipsOf(db, [{ id: orderId, needsPacking: true }])).get(orderId);

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

	test("once handed off, the slip goes back to what's left on the order", async () => {
		await buy([{ orderLineId: lineId, quantity: 2 }]);
		expect((await slip())?.items.map((l) => l.toPack)).toEqual([2]);
		await handOff((await db.select().from(schema.dispatches))[0].id);
		// The synced count still says none shipped, so all 3 print.
		expect((await slip())?.items).toEqual([
			expect.objectContaining({
				toPack: 3,
				sold: { quantity: 3, unitPrice: 10 },
			}),
		]);
	});
});
