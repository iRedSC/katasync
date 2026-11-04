import { eq } from "drizzle-orm";
import { describe, expect, test, vi } from "vitest";
import * as schema from "#/db/schema";
import { sendTracking, voidDispatch } from "#/shipping/handoff";
import {
	buy,
	db,
	freshOrder,
	handOff,
	lineId,
	orderId,
	shopify,
} from "#/shipping/several-shipments.fixtures";
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
