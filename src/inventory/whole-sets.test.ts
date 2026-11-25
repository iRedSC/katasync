import { sql } from "drizzle-orm";
import { beforeEach, describe, expect, test } from "vitest";
import type { Db } from "#/db/client";
import { recordReturn, recordSale } from "#/inventory/ledger";
import { setProductKind } from "#/products/kind";
import { movedSince } from "#/stock-push/on-change";
import { addDispatch, createProduct, createTestDb } from "#/test/db";
import { getBundleBlockers } from "./availability";
import { committedUnits } from "./commitments";
import { activate, channelOrder, quantityWorld } from "./commitments.fixtures";
import { consumeCommitments, returnSaleOf } from "./commitments-consume";
import { restoreCommitments } from "./commitments-restore";
import { assembleKits, disassembleKits } from "./ledger";
import { onlineStock } from "./online-stock";
import { setRecipe } from "./recipes";
import { createWholeSet, wholeToPack } from "./whole-sets";

let db: Db;
let world: Awaited<ReturnType<typeof quantityWorld>>;
let socket: number;
let ratchet: number;
let set: number;
let whole: number;

// A tool set of 2 sockets and a ratchet, with parts for 5 on the shelf and
// 3 more boxed whole.
beforeEach(async () => {
	db = await createTestDb();
	world = await quantityWorld(db);
	socket = await createProduct(db, "SOCKET", "simple");
	ratchet = await createProduct(db, "RATCHET", "simple");
	set = await createProduct(db, "SET", "bundle");
	await setRecipe(db, set, [
		{ productId: socket, quantity: 2 },
		{ productId: ratchet, quantity: 1 },
	]);
	whole = (await createWholeSet(db, set)).id;
	await world.stock(socket, world.warehouse, 10);
	await world.stock(ratchet, world.warehouse, 5);
	await world.stock(whole, world.warehouse, 3);
});

const order = (quantity: number, externalId = "gid://shopify/Order/1") =>
	world.ingest(
		channelOrder({
			externalId,
			lines: [
				{
					externalId: "line-1",
					listingExternalId: null,
					sku: "SET",
					title: "Set",
					quantity,
					shipped: 0,
					unitPrice: 200,
				},
			],
		}),
	);

const shelf = (productId: number) => world.onHand(productId, world.warehouse);

const committed = async (productId: number) =>
	(await committedUnits(db, [productId])).get(productId) ?? 0;

async function demand(productId: number) {
	const result = (await db.execute(
		sql`select coalesce(sum(units), 0)::int as n from sales_units where product_id = ${productId}`,
	)) as unknown as { rows: { n: number }[] };
	return Number(result.rows[0].n);
}

describe("a tool set with whole sets", () => {
	test("gets one whole kit, built from the set's parts", async () => {
		expect((await createWholeSet(db, set)).id).toBe(whole);
		await assembleKits(db, {
			kitProductId: whole,
			quantity: 1,
			locationId: world.warehouse,
		});
		expect(await shelf(whole)).toBe(4);
		expect(await shelf(socket)).toBe(8);
		expect(await shelf(ratchet)).toBe(4);
	});

	test("sells its boxes plus what its parts make, and boxes aren't parts", async () => {
		expect(await world.available(set)).toBe(8);
		expect(await world.available(socket)).toBe(10);
		// With no ratchets it still sells the boxes, so nothing blocks it.
		await world.stock(ratchet, world.warehouse, -5);
		expect(await world.available(set)).toBe(3);
		expect(await getBundleBlockers(db, await onlineStock(db))).toEqual([]);
	});

	test("an order takes boxes first, then parts for the rest", async () => {
		const { orderId } = await order(4);
		expect(await shelf(whole)).toBe(0);
		expect(await shelf(socket)).toBe(8);
		expect(await shelf(ratchet)).toBe(4);
		expect(await world.available(set)).toBe(4);
		expect(await wholeToPack(db, [orderId])).toEqual(
			new Map([[`${orderId}:${set}`, { sku: "SET-WHOLE", units: 3 }]]),
		);
		// The next one finds no boxes and sells from parts as it always did.
		const next = await order(1, "gid://shopify/Order/2");
		expect(await shelf(whole)).toBe(0);
		expect(await shelf(socket)).toBe(6);
		expect(await wholeToPack(db, [next.orderId])).toEqual(new Map());
	});

	test("a box sold counts as the set's parts sold", async () => {
		await order(1);
		expect(await shelf(whole)).toBe(2);
		expect(await demand(socket)).toBe(2);
		expect(await demand(ratchet)).toBe(1);
		expect(await demand(whole)).toBe(0);
	});

	test("a return comes back the way it went out", async () => {
		const { orderId } = await order(4);
		const [{ saleBatchId }] = (
			(await db.execute(
				sql`select sale_batch_id as "saleBatchId" from order_lines where order_id = ${orderId}`,
			)) as unknown as { rows: { saleBatchId: string }[] }
		).rows;
		const back = (quantity: number) =>
			recordReturn(db, {
				productId: set,
				quantity,
				locationId: world.warehouse,
				reference: "return",
				sale: { batchId: saleBatchId, quantity: 4 },
			});
		// One at a time, the three boxes come back, then the loose set: never
		// more boxes than went out.
		for (const boxes of [1, 2, 3]) {
			await back(1);
			expect(await shelf(whole)).toBe(boxes);
			expect(await shelf(socket)).toBe(8);
		}
		await back(1);
		expect(await shelf(whole)).toBe(3);
		expect(await shelf(socket)).toBe(10);
		expect(await shelf(ratchet)).toBe(5);
	});

	test("its parts can't change while a box holds the old ones", async () => {
		const parts = [{ productId: socket, quantity: 3 }];
		await expect(setRecipe(db, set, parts)).rejects.toThrow(
			"3 whole SET on hand hold the old parts",
		);
		await expect(
			setRecipe(db, whole, [{ productId: socket, quantity: 3 }]),
		).rejects.toThrow("is a whole set");
		const other = await createProduct(db, "OTHER", "bundle");
		await expect(
			setRecipe(db, other, [{ productId: whole, quantity: 1 }]),
		).rejects.toThrow("can't be a part");
		await expect(setProductKind(db, set, { kind: "simple" })).rejects.toThrow(
			"3 whole sets on hand",
		);
		await disassembleKits(db, {
			kitProductId: whole,
			quantity: 3,
			locationId: world.warehouse,
		});
		expect(await shelf(socket)).toBe(16);
		// With none left, the boxes follow the set.
		await setRecipe(db, set, parts);
		await assembleKits(db, {
			kitProductId: whole,
			quantity: 1,
			locationId: world.warehouse,
		});
		expect(await shelf(socket)).toBe(13);
		expect(await shelf(ratchet)).toBe(8);
	});

	test("a box moving pushes the set's stock, though no part moved", async () => {
		const bit = await createProduct(db, "BIT", "simple");
		const bits = await createProduct(db, "BITS", "bundle");
		await setRecipe(db, bits, [{ productId: bit, quantity: 1 }]);
		const { id: boxed } = await createWholeSet(db, bits);
		expect(await movedSince(db, new Date())).not.toContain(bits);
		await world.stock(boxed, world.warehouse, 1);
		expect(await movedSince(db, new Date())).toContain(bits);
	});
});

describe("a tool set with whole sets, once stock is committed", () => {
	beforeEach(() => activate(db));

	test("an order reserves boxes first and ships them first", async () => {
		const { orderId } = await order(4);
		const orderLineId = await world.lineId(orderId);
		expect(await committed(whole)).toBe(3);
		expect(await committed(socket)).toBe(2);
		expect(await committed(ratchet)).toBe(1);
		expect(await world.available(set)).toBe(4);
		expect(await world.available(socket)).toBe(8);
		expect(await wholeToPack(db, [orderId])).toEqual(
			new Map([[`${orderId}:${set}`, { sku: "SET-WHOLE", units: 3 }]]),
		);

		await addDispatch(db, { orderIds: [orderId] });
		await consumeCommitments(db, {
			orderId,
			lines: [{ orderLineId, quantity: 2 }],
			fulfillmentKey: "d1",
		});
		expect(await shelf(whole)).toBe(1);
		expect(await shelf(socket)).toBe(10);
		expect((await wholeToPack(db, [orderId])).get(`${orderId}:${set}`)).toEqual(
			{ sku: "SET-WHOLE", units: 1 },
		);

		await consumeCommitments(db, {
			orderId,
			lines: [{ orderLineId, quantity: 2 }],
			fulfillmentKey: "d2",
		});
		expect(await shelf(whole)).toBe(0);
		expect(await shelf(socket)).toBe(8);
		expect(await shelf(ratchet)).toBe(4);
		expect(await committed(whole)).toBe(0);
		expect(await committed(socket)).toBe(0);
		expect(await world.available(set)).toBe(4);

		// Voided, the last shipment goes back as it left: a box and parts.
		await restoreCommitments(db, { orderId, fulfillmentKey: "d2" });
		expect(await shelf(whole)).toBe(1);
		expect(await shelf(socket)).toBe(10);
		expect(await committed(whole)).toBe(1);
		expect(await committed(socket)).toBe(2);
	});

	test("shipped apart, a box and a loose set come back as a box and parts", async () => {
		await world.stock(whole, world.warehouse, -2);
		const { orderId } = await order(2);
		const orderLineId = await world.lineId(orderId);
		await addDispatch(db, { orderIds: [orderId] });
		for (const fulfillmentKey of ["a", "b"])
			await consumeCommitments(db, {
				orderId,
				lines: [{ orderLineId, quantity: 1 }],
				fulfillmentKey,
			});
		expect(await shelf(whole)).toBe(0);
		expect(await shelf(socket)).toBe(8);
		const sale = await returnSaleOf(db, orderLineId);
		expect(sale).toMatchObject({ quantity: 2 });
		await recordReturn(db, {
			productId: set,
			quantity: 2,
			locationId: world.warehouse,
			reference: "return",
			sale,
		});
		expect(await shelf(whole)).toBe(1);
		expect(await shelf(socket)).toBe(10);
		expect(await shelf(ratchet)).toBe(5);
	});

	test("boxes ship before parts even when the parts were reserved first", async () => {
		await world.stock(whole, world.warehouse, -3);
		const { orderId } = await order(2);
		const orderLineId = await world.lineId(orderId);
		await addDispatch(db, { orderIds: [orderId] });
		const ship = (fulfillmentKey: string) =>
			consumeCommitments(db, {
				orderId,
				lines: [{ orderLineId, quantity: 1 }],
				fulfillmentKey,
			});
		await ship("a");
		// A box arrives and the order grows: one box and one loose set left.
		await world.stock(whole, world.warehouse, 1);
		await world.ingest(
			channelOrder({
				sourceUpdatedAt: new Date("2026-10-06T12:00:00Z"),
				lines: [
					{
						externalId: "line-1",
						listingExternalId: null,
						sku: "SET",
						title: "Set",
						quantity: 3,
						shipped: 0,
						unitPrice: 200,
					},
				],
			}),
		);
		expect(await committed(whole)).toBe(1);
		// Voiding the first shipment reopens the older, loose reservation.
		await restoreCommitments(db, { orderId, fulfillmentKey: "a" });
		expect(await shelf(socket)).toBe(10);
		await ship("b");
		expect(await shelf(whole)).toBe(0);
		expect(await shelf(socket)).toBe(10);
		expect(await wholeToPack(db, [orderId])).toEqual(new Map());
	});

	test("a counter sale leaves the boxes orders reserved", async () => {
		await world.stock(whole, world.warehouse, -2);
		await order(1);
		expect(await committed(whole)).toBe(1);
		await recordSale(db, {
			productId: set,
			quantity: 1,
			locationId: world.warehouse,
			reference: "pos",
		});
		expect(await shelf(whole)).toBe(1);
		expect(await shelf(socket)).toBe(8);
	});

	test("orders share the boxes; a cancel frees them for the next", async () => {
		const first = await order(2);
		const second = await order(2, "gid://shopify/Order/2");
		expect(await committed(whole)).toBe(3);
		expect(await committed(socket)).toBe(2);
		expect(
			(await wholeToPack(db, [first.orderId, second.orderId])).get(
				`${second.orderId}:${set}`,
			),
		).toEqual({ sku: "SET-WHOLE", units: 1 });

		await world.ingest(
			channelOrder({
				cancelledAt: new Date("2026-10-06T12:00:00Z"),
				sourceUpdatedAt: new Date("2026-10-06T12:00:00Z"),
				lines: [
					{
						externalId: "line-1",
						listingExternalId: null,
						sku: "SET",
						title: "Set",
						quantity: 2,
						shipped: 0,
						unitPrice: 200,
					},
				],
			}),
		);
		expect(await committed(whole)).toBe(1);
		expect(await world.available(set)).toBe(6);
		const third = await order(3, "gid://shopify/Order/3");
		expect(await committed(whole)).toBe(3);
		expect(
			(await wholeToPack(db, [third.orderId])).get(`${third.orderId}:${set}`),
		).toEqual({ sku: "SET-WHOLE", units: 2 });
	});

	test("an edited order re-picks its boxes instead of doubling them", async () => {
		await order(1);
		expect(await committed(whole)).toBe(1);
		await world.ingest(
			channelOrder({
				sourceUpdatedAt: new Date("2026-10-06T12:00:00Z"),
				lines: [
					{
						externalId: "line-1",
						listingExternalId: null,
						sku: "SET",
						title: "Set",
						quantity: 5,
						shipped: 0,
						unitPrice: 200,
					},
				],
			}),
		);
		expect(await committed(whole)).toBe(3);
		expect(await committed(socket)).toBe(4);
		expect(await committed(ratchet)).toBe(2);
		expect(await world.available(set)).toBe(3);
	});
});
