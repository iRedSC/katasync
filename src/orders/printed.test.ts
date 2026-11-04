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
	shopify,
	storeId,
} from "#/shipping/several-shipments.fixtures";
import { type ChannelOrder, ingestOrder } from "./ingest";
import { recordPrinted } from "./printed";
import { needsPacking } from "./to-ship";

freshOrder();

const order = async () =>
	(
		await db
			.select({
				printedAt: schema.orders.invoicePrintedAt,
				version: schema.orders.pickingVersion,
				needsPacking,
			})
			.from(schema.orders)
			.where(eq(schema.orders.id, orderId))
	)[0];

// What Print all would pick up: still to pack and not printed.
const inPrintAll = async () => {
	const o = await order();
	return o.needsPacking && o.printedAt === null;
};

const print = async () => {
	const { version } = await order();
	return recordPrinted(db, [{ orderId, version }]);
};

describe("recording a print", () => {
	test("marks the order printed at the version its invoice showed", async () => {
		expect(await print()).toEqual({ changed: 0 });
		expect(await inPrintAll()).toBe(false);
	});

	test("a late acknowledgement from before a partial handoff leaves the order unprinted", async () => {
		const printedAt = (await order()).version;
		await buy([{ orderLineId: lineId, quantity: 1 }]);
		const [{ id }] = await db.select().from(schema.dispatches);
		await handOff(id);
		const late = await recordPrinted(db, [{ orderId, version: printedAt }]);
		expect(late).toEqual({ changed: 1 });
		expect(await inPrintAll()).toBe(true);
		// The invoice printed now, at the current version, is recorded.
		expect(await print()).toEqual({ changed: 0 });
		expect(await inPrintAll()).toBe(false);
	});

	test("a box bought bumps the version, so the slip that now shows it prints again", async () => {
		const before = (await order()).version;
		await buy([{ orderLineId: lineId, quantity: 1 }]);
		expect((await order()).version).toBeGreaterThan(before);
	});
});

describe("voiding an unsent box", () => {
	test("puts a printed order back in Print all", async () => {
		await buy([{ orderLineId: lineId, quantity: 1 }]);
		const [{ id }] = await db.select().from(schema.dispatches);
		const failing = shopify();
		failing.shopifyFulfill = vi.fn(async () => {
			throw new Error("Shopify answered 503");
		});
		vi.spyOn(console, "error").mockImplementation(() => {});
		await sendTracking(db, id, failing).catch(() => {});
		const [member] = await db
			.select({ sentAt: schema.dispatchOrders.channelSentAt })
			.from(schema.dispatchOrders);
		expect(member.sentAt).toBeNull();
		await print();
		expect(await inPrintAll()).toBe(false);
		const printedAt = (await order()).version;

		await voidDispatch(db, id, shopify());
		expect(await inPrintAll()).toBe(true);
		expect((await order()).version).toBeGreaterThan(printedAt);
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

describe("a sync", () => {
	test("that changes the lines between the slip and its acknowledgement leaves the order unprinted", async () => {
		const shown = (await order()).version;
		await ingest({ quantity: 4 });
		expect(await recordPrinted(db, [{ orderId, version: shown }])).toEqual({
			changed: 1,
		});
		expect(await inPrintAll()).toBe(true);
	});

	test("that changes what's to pick puts a printed order back in Print all", async () => {
		await print();
		await ingest({ shipped: 1 });
		expect(await inPrintAll()).toBe(true);
	});

	test("that says nothing new keeps the print", async () => {
		await ingest();
		await print();
		const printed = (await order()).version;
		await ingest();
		expect(await inPrintAll()).toBe(false);
		expect((await order()).version).toBe(printed);
	});
});

describe("a refused purchase", () => {
	// A print made while the box was waiting to be bought: its slip showed
	// the box, not the whole order.
	const printWhileBuying = async () => {
		await print();
		return (await order()).version;
	};

	test("refused outright puts the whole order back in Print all", async () => {
		let shown = -1;
		vi.mocked(buying.buyLabel).mockImplementationOnce(async () => {
			shown = await printWhileBuying();
			throw new LabelRefused("bad address");
		});
		await expect(buy([{ orderLineId: lineId, quantity: 1 }])).rejects.toThrow(
			"bad address",
		);
		expect(await inPrintAll()).toBe(true);
		expect(await recordPrinted(db, [{ orderId, version: shown }])).toEqual({
			changed: 1,
		});
	});

	test("found refused after no answer puts the whole order back in Print all", async () => {
		vi.mocked(buying.buyLabel).mockImplementationOnce(async () => {
			throw new Error("fetch failed: socket hang up");
		});
		const bought = await buy([{ orderLineId: lineId, quantity: 1 }]);
		const shown = await printWhileBuying();
		expect(await inPrintAll()).toBe(false);

		await checkLabelAttempt(db, bought.unsure as string, {
			lock: memoryLocker(),
			findShippo: vi.fn(async () => ({
				kind: "refused" as const,
				why: "Shippo: invalid address",
			})),
			findTiktok: vi.fn(),
		});
		expect(await inPrintAll()).toBe(true);
		expect(await recordPrinted(db, [{ orderId, version: shown }])).toEqual({
			changed: 1,
		});
	});
});
