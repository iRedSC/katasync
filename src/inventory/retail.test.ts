import { and, eq } from "drizzle-orm";
import { beforeEach, describe, expect, test } from "vitest";
import { stockLocations } from "#/channels/stores";
import type { Db } from "#/db/client";
import * as schema from "#/db/schema";
import { fromStore } from "#/orders/from-store";
import { type ChannelOrder, ingestOrder } from "#/orders/ingest";
import { applyStoreSales } from "#/orders/remap";
import { receiveReturn } from "#/orders/returns";
import { createProduct, createTestDb } from "#/test/db";
import { getAvailability } from "./availability";
import { postMovements } from "./ledger";
import { addRetailStore, PosLocationError, setPosLocation } from "./locations";
import { onlineStock, setRetailReserve } from "./online-stock";
import { setRecipe } from "./recipes";

let db: Db;
let warehouse: number;
let fba: number;
let storeId: number;
const stockFrom = new Date("2026-10-01T00:00:00Z");
const store = () => ({ id: storeId, stockFrom });

// The retail store; with pos, also where POS sales take from.
async function addRetail(options: { pos?: boolean } = {}) {
	const [{ id }] = await db
		.insert(schema.locations)
		.values({ name: "Store", kind: "retail" })
		.returning();
	if (options.pos) await setPosLocation(db, id);
	return id;
}

async function onHand(productId: number, locationId: number) {
	const [row] = await db
		.select()
		.from(schema.stockLevels)
		.where(
			and(
				eq(schema.stockLevels.productId, productId),
				eq(schema.stockLevels.locationId, locationId),
			),
		);
	return row?.onHand ?? 0;
}

async function stock(productId: number, locationId: number, qty: number) {
	await postMovements(db, {
		lines: [{ productId, locationId, delta: qty, reason: "opening_balance" }],
	});
}

function posOrder(extra: Partial<ChannelOrder> = {}): ChannelOrder {
	return {
		externalId: "gid://shopify/Order/1",
		name: "#1001",
		salesChannel: "Point of Sale",
		marketplaceOrderId: null,
		placedAt: new Date("2026-10-05T12:00:00Z"),
		cancelledAt: null,
		fulfillmentStatus: "FULFILLED",
		fulfilledByChannel: false,
		soldInStore: true,
		financialStatus: "PAID",
		customerName: null,
		buyerId: null,
		shipCity: null,
		shipRegion: null,
		shipCountry: null,
		shipAddress1: null,
		shipAddress2: null,
		shipPostalCode: null,
		shipPhone: null,
		total: 40,
		shippingCharged: 0,
		tax: { remittedBy: "seller", lines: [] },
		sourceUpdatedAt: new Date("2026-10-05T12:00:00Z"),
		lines: [
			{
				externalId: "line-1",
				listingExternalId: null,
				sku: "WRENCH",
				title: "Wrench",
				quantity: 2,
				unitPrice: 20,
			},
		],
		...extra,
	};
}

beforeEach(async () => {
	db = await createTestDb();
	[{ id: warehouse }, { id: fba }] = await db
		.insert(schema.locations)
		.values([
			{ name: "Warehouse", kind: "owned" },
			{ name: "Amazon FBA", kind: "fba" },
		])
		.returning();
	[{ id: storeId }] = await db
		.insert(schema.stores)
		.values({ channel: "shopify", name: "Shopify", stockFrom })
		.returning();
});

describe("in-store sales", () => {
	test("take stock off the retail store's shelf, not the warehouse's", async () => {
		const retail = await addRetail({ pos: true });
		const wrench = await createProduct(db, "WRENCH", "simple");
		await stock(wrench, warehouse, 10);
		await stock(wrench, retail, 5);

		await ingestOrder(db, store(), posOrder(), await stockLocations(db));

		expect(await onHand(wrench, warehouse)).toBe(10);
		expect(await onHand(wrench, retail)).toBe(3);
	});

	test("shipped orders still take from the warehouse", async () => {
		const retail = await addRetail({ pos: true });
		const wrench = await createProduct(db, "WRENCH", "simple");
		await stock(wrench, warehouse, 10);

		await ingestOrder(
			db,
			store(),
			posOrder({ soldInStore: false, salesChannel: "Online Store" }),
			await stockLocations(db),
		);

		expect(await onHand(wrench, warehouse)).toBe(8);
		expect(await onHand(wrench, retail)).toBe(0);
	});

	test("without a POS location, report it and take nothing", async () => {
		const wrench = await createProduct(db, "WRENCH", "simple");
		await stock(wrench, warehouse, 10);

		const { problems } = await ingestOrder(
			db,
			store(),
			posOrder(),
			await stockLocations(db),
		);

		expect(problems).toEqual([
			"#1001: no POS location to take in-store stock from",
		]);
		expect(await onHand(wrench, warehouse)).toBe(10);
	});

	test("take their stock once a POS location is set", async () => {
		const wrench = await createProduct(db, "WRENCH", "simple");
		await ingestOrder(db, store(), posOrder(), await stockLocations(db));
		const retail = await addRetail({ pos: true });

		expect(await applyStoreSales(db)).toEqual({ lines: 1, problems: [] });
		expect(await applyStoreSales(db)).toEqual({ lines: 0, problems: [] });
		expect(await onHand(wrench, retail)).toBe(-2);
		expect(await onHand(wrench, warehouse)).toBe(0);
	});

	test("caught up after adding the store, take the store's stock", async () => {
		const wrench = await createProduct(db, "WRENCH", "simple");
		await stock(wrench, warehouse, 10);
		await ingestOrder(db, store(), posOrder(), await stockLocations(db));

		const added = await addRetailStore(db, "Store");

		expect(await applyStoreSales(db)).toEqual({ lines: 1, problems: [] });
		expect(await onHand(wrench, added.locationId)).toBe(-2);
		expect(await onHand(wrench, warehouse)).toBe(10);
	});

	test("adding the store takes POS over from the warehouse", async () => {
		await setPosLocation(db, warehouse);
		const added = await addRetailStore(db, "Store");
		expect((await stockLocations(db)).pos).toBe(added.locationId);
		await expect(addRetailStore(db, "Other")).rejects.toThrow(
			"Store is already the retail store",
		);
	});

	test("restock where they sold from", async () => {
		const retail = await addRetail({ pos: true });
		const wrench = await createProduct(db, "WRENCH", "simple");
		await stock(wrench, retail, 5);
		const { orderId } = await ingestOrder(
			db,
			store(),
			posOrder(),
			await stockLocations(db),
		);
		const [line] = await db
			.select()
			.from(schema.orderLines)
			.where(eq(schema.orderLines.orderId, orderId));

		await receiveReturn(db, {
			orderId,
			lines: [{ lineId: line.id, quantity: 1 }],
			outcome: "restock",
		});

		expect(await onHand(wrench, retail)).toBe(4);
		expect(await onHand(wrench, warehouse)).toBe(0);
	});
});

describe("POS location", () => {
	test("a POS sale takes from the warehouse when it's POS primary", async () => {
		const retail = await addRetail();
		await setPosLocation(db, warehouse);
		const wrench = await createProduct(db, "WRENCH", "simple");
		await stock(wrench, warehouse, 10);
		await stock(wrench, retail, 5);

		await ingestOrder(db, store(), posOrder(), await stockLocations(db));

		expect(await onHand(wrench, warehouse)).toBe(8);
		expect(await onHand(wrench, retail)).toBe(5);
	});

	test("switching takes effect for the next sale, and leaves past ones", async () => {
		const retail = await addRetail();
		await setPosLocation(db, warehouse);
		const wrench = await createProduct(db, "WRENCH", "simple");
		await stock(wrench, warehouse, 10);
		await stock(wrench, retail, 5);
		await ingestOrder(db, store(), posOrder(), await stockLocations(db));

		await setPosLocation(db, retail);
		await ingestOrder(
			db,
			store(),
			posOrder({ externalId: "gid://shopify/Order/2", name: "#1002" }),
			await stockLocations(db),
		);

		expect(await onHand(wrench, warehouse)).toBe(8);
		expect(await onHand(wrench, retail)).toBe(3);
		const primary = await db
			.select({ id: schema.locations.id })
			.from(schema.locations)
			.where(eq(schema.locations.posPrimary, true));
		expect(primary).toEqual([{ id: retail }]);
	});

	test("Amazon's FBA can't be chosen", async () => {
		await setPosLocation(db, warehouse);

		await expect(setPosLocation(db, fba)).rejects.toThrow(PosLocationError);
		await expect(
			db
				.update(schema.locations)
				.set({ posPrimary: true })
				.where(eq(schema.locations.id, fba)),
		).rejects.toThrow();
		expect((await stockLocations(db)).pos).toBe(warehouse);
	});

	test("only one location is POS primary", async () => {
		await setPosLocation(db, warehouse);

		await expect(addRetail()).resolves.toBeGreaterThan(0);
		await expect(
			db
				.update(schema.locations)
				.set({ posPrimary: true })
				.where(eq(schema.locations.kind, "retail")),
		).rejects.toThrow();
	});
});

describe("overflow", () => {
	const shipped = (extra: Partial<ChannelOrder> = {}) =>
		posOrder({ soldInStore: false, salesChannel: "Online Store", ...extra });

	async function fetchList(orderId: number) {
		const rows = await db
			.select({ parts: fromStore })
			.from(schema.orderLines)
			.innerJoin(schema.orders, eq(schema.orders.id, schema.orderLines.orderId))
			.where(eq(schema.orderLines.orderId, orderId));
		return rows.flatMap((r) => r.parts);
	}

	test("a shipped order takes what the warehouse is out of from the store", async () => {
		const retail = await addRetail();
		const wrench = await createProduct(db, "WRENCH", "simple");
		await stock(wrench, warehouse, 1);
		await stock(wrench, retail, 5);

		const { orderId } = await ingestOrder(
			db,
			store(),
			shipped(),
			await stockLocations(db),
		);

		expect(await onHand(wrench, warehouse)).toBe(0);
		expect(await onHand(wrench, retail)).toBe(4);
		expect(await fetchList(orderId)).toEqual([
			{ sku: "WRENCH", location: "Store", quantity: 1 },
		]);
	});

	test("what neither holds is oversold at the warehouse", async () => {
		const retail = await addRetail();
		const wrench = await createProduct(db, "WRENCH", "simple");
		await stock(wrench, warehouse, 1);

		const { orderId } = await ingestOrder(
			db,
			store(),
			shipped(),
			await stockLocations(db),
		);

		expect(await onHand(wrench, warehouse)).toBe(-1);
		expect(await onHand(wrench, retail)).toBe(0);
		expect(await fetchList(orderId)).toEqual([]);
	});

	test("a tool set's parts each come from wherever they are", async () => {
		const retail = await addRetail();
		const set = await createProduct(db, "SET", "bundle");
		const knife = await createProduct(db, "KNIFE", "simple");
		const blade = await createProduct(db, "BLADE", "simple");
		await setRecipe(db, set, [
			{ productId: knife, quantity: 1 },
			{ productId: blade, quantity: 1 },
		]);
		await stock(knife, warehouse, 5);
		await stock(blade, retail, 5);

		const { orderId } = await ingestOrder(
			db,
			store(),
			shipped({
				lines: [
					{
						externalId: "line-1",
						listingExternalId: null,
						sku: "SET",
						title: "Set",
						quantity: 2,
						unitPrice: 40,
					},
				],
			}),
			await stockLocations(db),
		);

		expect(await onHand(knife, warehouse)).toBe(3);
		expect(await onHand(blade, retail)).toBe(3);
		expect(await fetchList(orderId)).toEqual([
			{ sku: "BLADE", location: "Store", quantity: 2 },
		]);
	});

	test("cancelling gives each shelf back what it gave", async () => {
		const retail = await addRetail();
		const wrench = await createProduct(db, "WRENCH", "simple");
		await stock(wrench, warehouse, 1);
		await stock(wrench, retail, 5);
		const from = await stockLocations(db);
		const { orderId } = await ingestOrder(db, store(), shipped(), from);

		await ingestOrder(
			db,
			store(),
			shipped({ cancelledAt: new Date("2026-10-06T00:00:00Z") }),
			from,
		);

		expect(await onHand(wrench, warehouse)).toBe(1);
		expect(await onHand(wrench, retail)).toBe(5);
		expect(await fetchList(orderId)).toEqual([]);
	});

	test("a return of a split sale goes back to the warehouse", async () => {
		const retail = await addRetail();
		const wrench = await createProduct(db, "WRENCH", "simple");
		await stock(wrench, warehouse, 1);
		await stock(wrench, retail, 5);
		const { orderId } = await ingestOrder(
			db,
			store(),
			shipped({ fulfillmentStatus: "FULFILLED" }),
			await stockLocations(db),
		);
		const [line] = await db
			.select()
			.from(schema.orderLines)
			.where(eq(schema.orderLines.orderId, orderId));

		await receiveReturn(db, {
			orderId,
			lines: [{ lineId: line.id, quantity: 2 }],
			outcome: "restock",
		});

		expect(await onHand(wrench, warehouse)).toBe(2);
		expect(await onHand(wrench, retail)).toBe(4);
	});

	test("the store keeps its reserve: online gets only what's above it", async () => {
		const retail = await addRetail();
		await setRetailReserve(db, 2);
		const wrench = await createProduct(db, "WRENCH", "simple");
		await stock(wrench, retail, 3);

		expect(
			(await getAvailability(db, [wrench], await onlineStock(db))).get(wrench),
		).toBe(1);
		await ingestOrder(db, store(), shipped(), await stockLocations(db));

		expect(await onHand(wrench, retail)).toBe(2);
		expect(await onHand(wrench, warehouse)).toBe(-1);
		expect(
			(await getAvailability(db, [wrench], await onlineStock(db))).get(wrench),
		).toBe(0);
	});

	test("an in-store sale never takes the warehouse's stock", async () => {
		const retail = await addRetail({ pos: true });
		const wrench = await createProduct(db, "WRENCH", "simple");
		await stock(wrench, warehouse, 10);

		const { orderId } = await ingestOrder(
			db,
			store(),
			posOrder(),
			await stockLocations(db),
		);

		expect(await onHand(wrench, warehouse)).toBe(10);
		expect(await onHand(wrench, retail)).toBe(-2);
		expect(await fetchList(orderId)).toEqual([]);
	});
});
