import { eq } from "drizzle-orm";
import { describe, expect, test, vi } from "vitest";
import * as schema from "#/db/schema";
import { memoryLocker } from "#/shipping/dispatch";
import { sendTracking, voidDispatch } from "#/shipping/handoff";
import { LabelRefused } from "#/shipping/label-attempt-state";
import { checkLabelAttempt } from "#/shipping/label-attempts";
import {
	buy,
	buying,
	db,
	freshOrder,
	handOff,
	lineId,
	orderId,
	shipOutside,
	shopify,
	storeId,
	sync,
} from "#/shipping/several-shipments.fixtures";
import { type ChannelOrder, ingestOrder } from "./ingest";
import { recordPrinted } from "./printed";
import { inPrintAll, plain, printed } from "./to-ship";

freshOrder();

// The order as Print all and To ship read it.
const order = async () =>
	(
		await db
			.select({
				printedAt: schema.orders.invoicePrintedAt,
				version: schema.orders.pickingVersion,
				plain,
				printed,
				inPrintAll,
			})
			.from(schema.orders)
			.where(eq(schema.orders.id, orderId))
	)[0];

// Prints the order now and acknowledges it, as the print page does.
const print = async () => {
	const { version } = await order();
	return recordPrinted(db, [{ orderId, version }]);
};

// Never shown as printed, and Print all takes it, however often it prints.
const alwaysPrintsAgain = async () => {
	const o = await order();
	expect(o.printed).toBe(false);
	expect(o.inPrintAll).toBe(true);
};

describe("a plain order", () => {
	test("printed leaves Print all and shows as printed", async () => {
		expect((await order()).plain).toBe(true);
		expect(await print()).toEqual({ changed: 0 });
		expect(await order()).toMatchObject({ printed: true, inPrintAll: false });
	});

	test("a line change between the slip and a late acknowledgement leaves it unprinted", async () => {
		const shown = (await order()).version;
		await ingest({ quantity: 4 });
		expect(await recordPrinted(db, [{ orderId, version: shown }])).toEqual({
			changed: 1,
		});
		await alwaysPrintsAgain();
		// The invoice printed now, at the current version, is recorded.
		expect(await print()).toEqual({ changed: 0 });
		expect((await order()).inPrintAll).toBe(false);
	});

	test("a line change after printing puts it back in Print all", async () => {
		await print();
		await ingest({ quantity: 4 });
		await alwaysPrintsAgain();
	});

	test("an identical re-sync keeps the print", async () => {
		await ingest();
		await print();
		const before = (await order()).version;
		await ingest();
		expect(await order()).toMatchObject({
			printed: true,
			inPrintAll: false,
			version: before,
		});
	});
});

describe("an order that isn't plain", () => {
	test("with shipped units, no dispatch: never printed", async () => {
		await sync(1);
		expect((await order()).plain).toBe(false);
		expect(await print()).toEqual({ changed: 1 });
		await alwaysPrintsAgain();
	});

	test("printed while plain, then a box bought: back in Print all", async () => {
		await print();
		expect((await order()).inPrintAll).toBe(false);
		await buy([{ orderLineId: lineId, quantity: 1 }]);
		// The waiting box isn't to pack, but the rest is: still on To ship.
		await alwaysPrintsAgain();
		expect(await print()).toEqual({ changed: 1 });
		await alwaysPrintsAgain();
	});

	test("partly handed off: a late acknowledgement leaves it in Print all", async () => {
		const shown = (await order()).version;
		const { dispatchId } = await buy([{ orderLineId: lineId, quantity: 1 }]);
		await handOff(dispatchId);
		expect(await recordPrinted(db, [{ orderId, version: shown }])).toEqual({
			changed: 1,
		});
		await alwaysPrintsAgain();
		// Even acknowledged at the current version.
		expect(await print()).toEqual({ changed: 1 });
		await alwaysPrintsAgain();
	});
});

// The five ways a print went stale that triggers kept missing. Each order
// has a dispatch or shipped units, so its print never counts.
describe("what earlier reviews found", () => {
	test("a refunded label changing whether its box is live", async () => {
		const { dispatchId } = await buy([{ orderLineId: lineId, quantity: 1 }]);
		await print();
		await voidDispatch(db, dispatchId, shopify());
		await alwaysPrintsAgain();
		expect(await print()).toEqual({ changed: 1 });
		await alwaysPrintsAgain();
	});

	test("a refused purchase found after no answer", async () => {
		vi.mocked(buying.buyLabel).mockImplementationOnce(async () => {
			throw new Error("fetch failed: socket hang up");
		});
		const bought = await buy([{ orderLineId: lineId, quantity: 1 }]);
		await print();
		await alwaysPrintsAgain();
		await checkLabelAttempt(db, bought.unsure as string, {
			lock: memoryLocker(),
			findShippo: vi.fn(async () => ({
				kind: "refused" as const,
				why: "Shippo: invalid address",
			})),
			findTiktok: vi.fn(),
		});
		await alwaysPrintsAgain();
	});

	test("a refused purchase, printed while buying", async () => {
		vi.mocked(buying.buyLabel).mockImplementationOnce(async () => {
			await print();
			throw new LabelRefused("bad address");
		});
		await expect(buy([{ orderLineId: lineId, quantity: 1 }])).rejects.toThrow(
			"bad address",
		);
		await alwaysPrintsAgain();
	});

	test("a new box after an old print", async () => {
		const first = await buy([{ orderLineId: lineId, quantity: 1 }]);
		await handOff(first.dispatchId);
		await print();
		await buy([{ orderLineId: lineId, quantity: 1 }]);
		await alwaysPrintsAgain();
	});

	test("the marketplace's open count changing between slip and acknowledgement", async () => {
		const { dispatchId } = await buy([{ orderLineId: lineId, quantity: 1 }]);
		await handOff(dispatchId);
		const shown = (await order()).version;
		shipOutside(1);
		expect(await recordPrinted(db, [{ orderId, version: shown }])).toEqual({
			changed: 1,
		});
		await alwaysPrintsAgain();
	});

	test("a ? slip is never marked printed", async () => {
		await db
			.update(schema.orderLines)
			.set({ shippedQuantity: null })
			.where(eq(schema.orderLines.id, lineId));
		expect(await print()).toEqual({ changed: 1 });
		expect((await order()).printedAt).toBeNull();
		await alwaysPrintsAgain();
	});

	test("routing or eligibility changing after the print", async () => {
		const { dispatchId } = await buy([{ orderLineId: lineId, quantity: 1 }]);
		await voidDispatch(db, dispatchId, shopify());
		await print();
		const [moved] = await db
			.insert(schema.stores)
			.values({ channel: "shopify", name: "Shopify 2" })
			.returning();
		await db
			.update(schema.orders)
			.set({ storeId: moved.id, fulfillmentStatus: "PARTIALLY_FULFILLED" })
			.where(eq(schema.orders.id, orderId));
		await alwaysPrintsAgain();
	});

	test("a send that failed, then a void of the unsent box", async () => {
		const { dispatchId } = await buy([{ orderLineId: lineId, quantity: 1 }]);
		const failing = shopify();
		failing.shopifyFulfill = vi.fn(async () => {
			throw new Error("Shopify answered 503");
		});
		vi.spyOn(console, "error").mockImplementation(() => {});
		await sendTracking(db, dispatchId, failing).catch(() => {});
		await print();
		await voidDispatch(db, dispatchId, shopify());
		await alwaysPrintsAgain();
	});
});

// The fixture's order "1" as the next sync reads it: 3 wrenches, none
// shipped, unless a test says otherwise.
async function ingest(line: Partial<ChannelOrder["lines"][number]> = {}) {
	const [{ id: shipping }] = await db.select().from(schema.locations);
	const synced: ChannelOrder = {
		externalId: "gid://shopify/Order/1",
		name: "1",
		salesChannel: "Online Store",
		marketplaceOrderId: null,
		placedAt: new Date(),
		cancelledAt: null,
		fulfillmentStatus: "UNFULFILLED",
		fulfilledByChannel: false,
		soldInStore: false,
		financialStatus: "PAID",
		customerName: "Pat Doe",
		buyerId: null,
		shipCity: "Erie",
		shipRegion: "PA",
		shipCountry: "US",
		shipAddress1: "12 Oak St",
		shipAddress2: null,
		shipPostalCode: "16501",
		shipPhone: null,
		total: 45,
		shippingCharged: 0,
		tax: { remittedBy: "seller", lines: [] },
		sourceUpdatedAt: new Date(),
		lines: [
			{
				externalId: "line-1",
				listingExternalId: null,
				sku: "WRENCH",
				title: "Wrench",
				quantity: 3,
				shipped: 0,
				unitPrice: 10,
				...line,
			},
		],
	};
	await ingestOrder(db, { id: storeId, stockFrom: null }, synced, {
		shipping,
		store: null,
		pos: null,
		storeKeeps: 0,
	});
}
