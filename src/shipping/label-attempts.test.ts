import { eq, sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { Db } from "#/db/client";
import * as schema from "#/db/schema";
import { createTestDb } from "#/test/db";
import { type BoxPlan, type BuyOutside, buyDispatch } from "./buy";
import { contentsKey } from "./contents";
import { memoryLocker } from "./dispatch";
import { LabelRefused, type Lookup } from "./label-attempt-state";
import { type CheckOutside, checkLabelAttempt } from "./label-attempts";
import { linesToPack } from "./packed";

let db: Db;
let storeId: number;
let n = 0;

async function addOrder(name: string, quantity = 2) {
	const [row] = await db
		.insert(schema.orders)
		.values({
			storeId,
			externalId: name,
			name,
			placedAt: new Date(),
			fulfillmentStatus: "UNFULFILLED",
			total: 30,
			sourceUpdatedAt: new Date(),
			shipAddress1: "12 Oak St",
			shipCity: "Erie",
			shipPostalCode: "16501",
			shipCountry: "US",
		})
		.returning();
	await db.insert(schema.orderLines).values({
		orderId: row.id,
		externalId: `${name}-line`,
		sku: "WRENCH",
		title: "Wrench",
		quantity,
		unitPrice: 15,
	});
	return row.id;
}

const lock = memoryLocker();

function fakes(overrides: Partial<BuyOutside> = {}): BuyOutside {
	return {
		lock,
		getRates: vi.fn(async () => {
			n++;
			return {
				rates: [
					{
						id: `g${n}`,
						carrier: "USPS",
						service: "ground",
						serviceName: "USPS Ground",
						cost: 7,
						days: 3,
					},
				],
				notes: [],
			};
		}),
		getRate: vi.fn(async (rateId: string) => ({
			id: rateId,
			carrier: "USPS",
			carrierToken: "usps",
			service: "ground",
			serviceName: "USPS Ground",
			cost: 7,
			days: 3,
		})),
		buyLabel: vi.fn(async (rateId: string) => {
			n++;
			return {
				id: `tx${n}`,
				labelUrl: "https://example.com/l.pdf",
				trackingNumber: `9400${n}-${rateId}`,
				trackingUrl: null,
			};
		}),
		refund: vi.fn(async () => ({ status: "QUEUED" })),
		tiktokBuy: vi.fn(),
		tiktokUnits: vi.fn(),
		ebayCheck: vi.fn(async () => {}),
		isTest: () => false,
		...overrides,
	};
}

const checking = (found: Lookup): CheckOutside => ({
	lock,
	findShippo: vi.fn(async () => found),
	findTiktok: vi.fn(),
});

const timesOut = () =>
	vi.fn(async () => {
		throw new Error("fetch failed: socket hang up");
	});

const box: BoxPlan = {
	packageId: null,
	lengthMm: 300,
	widthMm: 200,
	heightMm: 100,
	weightGrams: 600,
	insureAmount: null,
	hazmat: false,
};

const buy = async (orderIds: number[], boxes: number, outside: BuyOutside) =>
	buyDispatch(
		db,
		{
			orderIds,
			contentsKey: contentsKey(await linesToPack(db, orderIds)),
			boxes: Array.from({ length: boxes }, () => box),
			choice: { carrier: "USPS", service: "ground", id: "r", total: 100 },
			signature: false,
		},
		outside,
	);

const attemptsOf = (dispatchId: number) =>
	db
		.select()
		.from(schema.labelAttempts)
		.where(eq(schema.labelAttempts.dispatchId, dispatchId))
		.orderBy(schema.labelAttempts.boxIndex);

const dispatchOf = async (id: number) =>
	(
		await db
			.select()
			.from(schema.dispatches)
			.where(eq(schema.dispatches.id, id))
	)[0];

const found = (externalId: string): Lookup => ({
	kind: "bought",
	label: {
		externalId,
		trackingNumber: "9400FOUND",
		trackingUrl: null,
		labelUrl: "https://example.com/found.pdf",
		voided: null,
	},
});

beforeEach(async () => {
	n = 0;
	db = await createTestDb();
	[{ id: storeId }] = await db
		.insert(schema.stores)
		.values({ channel: "shopify", name: "Shopify" })
		.returning();
	await db.insert(schema.locations).values({
		name: "Warehouse",
		kind: "owned",
		address1: "1 Mill Rd",
		city: "Erie",
		postalCode: "16502",
		country: "US",
		email: "ship@example.com",
	});
});

afterEach(() => {
	vi.useRealTimers();
});

describe("packed contents", () => {
	test("a purchase keeps every line's packed quantity with the dispatch", async () => {
		const a = await addOrder("#1", 3);
		const bought = await buy([a], 1, fakes());
		const dispatch = await dispatchOf(bought.dispatchId);
		expect(dispatch).toMatchObject({ contents: "packed", boxCount: 1 });
		const lines = await db.select().from(schema.dispatchLines);
		expect(lines).toEqual([
			expect.objectContaining({
				dispatchId: bought.dispatchId,
				orderId: a,
				lineExternalId: "#1-line",
				quantity: 3,
			}),
		]);
		await expect(
			db.update(schema.dispatchLines).set({ quantity: 1 }),
		).rejects.toThrow();
		await expect(
			db
				.update(schema.dispatches)
				.set({ contents: "unknown", boxCount: null })
				.where(eq(schema.dispatches.id, bought.dispatchId)),
		).rejects.toThrow();
	});

	test("an order edited after packing stops the purchase with nothing bought", async () => {
		const a = await addOrder("#1", 2);
		const shown = contentsKey(await linesToPack(db, [a]));
		await db
			.update(schema.orderLines)
			.set({ quantity: 1 })
			.where(eq(schema.orderLines.orderId, a));
		const outside = fakes();
		await expect(
			buyDispatch(
				db,
				{
					orderIds: [a],
					contentsKey: shown,
					boxes: [box],
					choice: { carrier: "USPS", service: "ground", id: "r", total: 100 },
					signature: false,
				},
				outside,
			),
		).rejects.toThrow("changed since it was packed");
		expect(outside.buyLabel).not.toHaveBeenCalled();
		expect(await db.select().from(schema.dispatches)).toHaveLength(0);
	});

	test("a packed dispatch can't be saved without lines, nor lines added to an unknown one", async () => {
		await expect(
			db.transaction(async (tx) => {
				await tx
					.insert(schema.dispatches)
					.values({ contentsKey: "X", contents: "packed", boxCount: 1 });
			}),
		).rejects.toThrow();
		const a = await addOrder("#1");
		const [legacy] = await db
			.insert(schema.dispatches)
			.values({ contentsKey: "X" })
			.returning();
		expect(legacy).toMatchObject({ contents: "unknown", boxCount: null });
		await db
			.insert(schema.dispatchOrders)
			.values({ dispatchId: legacy.id, orderId: a });
		await expect(
			db.insert(schema.dispatchLines).values({
				dispatchId: legacy.id,
				orderId: a,
				lineExternalId: "#1-line",
				title: "Wrench",
				quantity: 2,
			}),
		).rejects.toThrow();
	});
});

describe("label attempts", () => {
	test("a refused purchase is recorded failed and the order can buy again", async () => {
		const a = await addOrder("#1");
		const outside = fakes({
			buyLabel: vi.fn(async () => {
				throw new LabelRefused("bad address");
			}),
		});
		await expect(buy([a], 1, outside)).rejects.toThrow("bad address");
		const [attempt] = await db.select().from(schema.labelAttempts);
		expect(attempt).toMatchObject({ state: "failed", error: "bad address" });
		expect((await buy([a], 1, fakes())).failed).toBeNull();
	});

	test("a timeout after the charge blocks buying again until it's checked", async () => {
		const a = await addOrder("#1");
		const outside = fakes({ buyLabel: timesOut() });
		const bought = await buy([a], 1, outside);
		expect(bought.unsure).not.toBeNull();
		expect(bought.failed).toContain("may have been bought");
		const [attempt] = await attemptsOf(bought.dispatchId);
		expect(attempt).toMatchObject({
			id: bought.unsure,
			state: "unknown",
			shipmentId: null,
		});
		expect(await db.select().from(schema.shipments)).toEqual([]);

		const again = fakes();
		await expect(buy([a], 1, again)).rejects.toThrow("may have been charged");
		expect(again.buyLabel).not.toHaveBeenCalled();
	});

	test("checking finds the label the lost answer bought, records it once, and completes the dispatch", async () => {
		const a = await addOrder("#1");
		const bought = await buy([a], 1, fakes({ buyLabel: timesOut() }));
		const id = bought.unsure as string;
		const outside = checking(found("tx-found"));

		const first = await checkLabelAttempt(db, id, outside);
		expect(first.attempt.state).toBe("succeeded");
		expect(first.completed).toBe(true);
		const [label] = await db.select().from(schema.shipments);
		expect(label).toMatchObject({
			externalId: "tx-found",
			trackingNumber: "9400FOUND",
			cost: 7,
			provider: "shippo",
		});
		expect(first.attempt.shipmentId).toBe(label.id);
		expect((await dispatchOf(bought.dispatchId)).boughtAt).not.toBeNull();

		const twice = await checkLabelAttempt(db, id, outside);
		expect(twice).toMatchObject({ completed: false });
		expect(outside.findShippo).toHaveBeenCalledTimes(1);
		expect(await db.select().from(schema.shipments)).toHaveLength(1);
	});

	test("checking that finds a refusal frees the order", async () => {
		const a = await addOrder("#1");
		const bought = await buy([a], 1, fakes({ buyLabel: timesOut() }));
		const r = await checkLabelAttempt(
			db,
			bought.unsure as string,
			checking({ kind: "refused", why: "Shippo: invalid address" }),
		);
		expect(r.attempt).toMatchObject({
			state: "failed",
			error: "Shippo: invalid address",
		});
		expect((await buy([a], 1, fakes())).failed).toBeNull();
	});

	test("finding nothing, however late, keeps it unknown and blocking", async () => {
		const a = await addOrder("#1");
		const bought = await buy([a], 1, fakes({ buyLabel: timesOut() }));
		const id = bought.unsure as string;
		vi.useFakeTimers({ toFake: ["Date"] });
		vi.setSystemTime(Date.now() + 24 * 3_600_000);
		const r = await checkLabelAttempt(db, id, checking({ kind: "none" }));
		expect(r.attempt).toMatchObject({ state: "unknown", lastLookup: "none" });
		vi.useRealTimers();
		const again = fakes();
		await expect(buy([a], 1, again)).rejects.toThrow("may have been charged");
		expect(again.buyLabel).not.toHaveBeenCalled();
	});

	test("a label found that's already recorded elsewhere stays unknown", async () => {
		const a = await addOrder("#1");
		const first = await buy([a], 1, fakes());
		const [taken] = await db.select().from(schema.shipments);
		await db
			.update(schema.shipments)
			.set({ voidedAt: new Date() })
			.where(eq(schema.shipments.dispatchId, first.dispatchId));
		const bought = await buy([a], 1, fakes({ buyLabel: timesOut() }));
		const r = await checkLabelAttempt(
			db,
			bought.unsure as string,
			checking(found(taken.externalId)),
		);
		expect(r.attempt).toMatchObject({
			state: "unknown",
			lastLookup: "pending",
		});
		expect(await db.select().from(schema.shipments)).toHaveLength(1);
	});

	test("every box bought but the dispatch left unmarked is finished by checking any box", async () => {
		const a = await addOrder("#1");
		const bought = await buy([a], 1, fakes());
		expect((await dispatchOf(bought.dispatchId)).boughtAt).not.toBeNull();
		await db
			.update(schema.dispatches)
			.set({ boughtAt: null })
			.where(eq(schema.dispatches.id, bought.dispatchId));
		const [attempt] = await attemptsOf(bought.dispatchId);
		const r = await checkLabelAttempt(
			db,
			attempt.id,
			checking({ kind: "none" }),
		);
		expect(r).toMatchObject({ completed: true });
		expect((await dispatchOf(bought.dispatchId)).boughtAt).not.toBeNull();
		const twice = await checkLabelAttempt(
			db,
			attempt.id,
			checking({ kind: "none" }),
		);
		expect(twice.completed).toBe(false);
	});

	test("box 2 of 2 unanswered keeps box 1 live; finding it completes the dispatch", async () => {
		const a = await addOrder("#1");
		let calls = 0;
		const outside = fakes({
			buyLabel: vi.fn(async (rateId: string) => {
				calls++;
				if (calls === 2) throw new Error("timeout");
				return {
					id: `tx-${rateId}`,
					labelUrl: "u",
					trackingNumber: "T1",
					trackingUrl: null,
				};
			}),
		});
		const bought = await buy([a], 2, outside);
		expect(bought.boxes).toHaveLength(1);
		expect(bought.boxes[0].voidedAt).toBeNull();
		expect(outside.refund).not.toHaveBeenCalled();
		expect((await dispatchOf(bought.dispatchId)).boughtAt).toBeNull();
		expect((await attemptsOf(bought.dispatchId)).map((x) => x.state)).toEqual([
			"succeeded",
			"unknown",
		]);

		const r = await checkLabelAttempt(
			db,
			bought.unsure as string,
			checking(found("tx-box-2")),
		);
		expect(r.completed).toBe(true);
		expect((await dispatchOf(bought.dispatchId)).boughtAt).not.toBeNull();
	});

	test("box 2 of 3 found later leaves the dispatch incomplete: box 3 was never bought", async () => {
		const a = await addOrder("#1");
		let calls = 0;
		const outside = fakes({
			buyLabel: vi.fn(async (rateId: string) => {
				calls++;
				if (calls === 2) throw new Error("timeout");
				return {
					id: `tx-${rateId}`,
					labelUrl: "u",
					trackingNumber: "T1",
					trackingUrl: null,
				};
			}),
		});
		const bought = await buy([a], 3, outside);
		expect(outside.buyLabel).toHaveBeenCalledTimes(2);
		const r = await checkLabelAttempt(
			db,
			bought.unsure as string,
			checking(found("tx-box-2")),
		);
		expect(r.completed).toBe(false);
		expect((await dispatchOf(bought.dispatchId)).boughtAt).toBeNull();
	});

	test("a label refunded at Shippo since is recorded voided, not live", async () => {
		const a = await addOrder("#1");
		const bought = await buy([a], 1, fakes({ buyLabel: timesOut() }));
		await checkLabelAttempt(
			db,
			bought.unsure as string,
			checking({
				kind: "bought",
				label: {
					externalId: "tx-refunded",
					trackingNumber: null,
					trackingUrl: null,
					labelUrl: null,
					voided: { refundStatus: "REFUNDED" },
				},
			}),
		);
		const [label] = await db.select().from(schema.shipments);
		expect(label.voidedAt).not.toBeNull();
		expect(label.refundStatus).toBe("REFUNDED");
	});

	test("the database refuses moves out of a final state, back to pending, or deleting", async () => {
		const a = await addOrder("#1");
		const bought = await buy([a], 1, fakes());
		const [attempt] = await attemptsOf(bought.dispatchId);
		expect(attempt.state).toBe("succeeded");
		await expect(
			db.execute(
				sql`update label_attempts set state = 'unknown', shipment_id = null, settled_at = null where id = ${attempt.id}`,
			),
		).rejects.toThrow();
		await expect(
			db.execute(sql`delete from label_attempts where id = ${attempt.id}`),
		).rejects.toThrow();

		const b = await addOrder("#2");
		const unsure = await buy([b], 1, fakes({ buyLabel: timesOut() }));
		await expect(
			db.execute(
				sql`update label_attempts set state = 'pending' where id = ${unsure.unsure}`,
			),
		).rejects.toThrow();
		await expect(
			db.execute(
				sql`update label_attempts set rate_id = 'other' where id = ${unsure.unsure}`,
			),
		).rejects.toThrow();
	});

	test("a purchase left pending by a crash is settled by checking", async () => {
		const [{ id: dispatchId }] = await db
			.insert(schema.dispatches)
			.values({ contentsKey: "X" })
			.returning();
		const b = await addOrder("#2");
		await db.insert(schema.dispatchOrders).values({ dispatchId, orderId: b });
		const [orphan] = await db
			.insert(schema.labelAttempts)
			.values({
				id: crypto.randomUUID(),
				dispatchId,
				boxIndex: 0,
				provider: "shippo",
				rateId: "r-orphan",
				box: {
					dispatchId,
					lengthMm: 1,
					widthMm: 1,
					heightMm: 1,
					weightGrams: 1,
					provider: "shippo",
					carrier: "USPS",
					service: "ground",
					serviceName: "USPS Ground",
					cost: 7,
					test: false,
				},
			})
			.returning();
		await expect(buy([b], 1, fakes())).rejects.toThrow("may have been charged");
		const r = await checkLabelAttempt(
			db,
			orphan.id,
			checking({ kind: "none" }),
		);
		expect(r.attempt.state).toBe("unknown");
	});

	describe("TikTok", () => {
		const tiktokOrder = async () => {
			const a = await addOrder("#1", 2);
			await db
				.update(schema.orders)
				.set({ salesChannel: "TikTok", marketplaceOrderId: "tiktok:577" })
				.where(eq(schema.orders.id, a));
			return a;
		};
		const units = (ids: string[]) =>
			vi.fn(async () => ({
				status: "AWAITING_SHIPMENT",
				packages: [],
				units: ids.map((id) => ({
					id,
					skuId: "s",
					sellerSku: "WRENCH",
					cancelled: false,
					packageId: null,
				})),
			}));
		const tiktokBuy = vi.fn(async () => ({
			packageId: "pkg-1",
			rate: {
				id: "r",
				carrier: "USPS",
				service: "Ground",
				serviceName: "USPS Ground",
				cost: 6,
				days: null,
			},
		}));

		test("buys exactly TikTok's units for the box and keeps them with the purchase", async () => {
			const a = await tiktokOrder();
			const outside = fakes({ tiktokUnits: units(["u1", "u2"]), tiktokBuy });
			expect((await buy([a], 1, outside)).failed).toBeNull();
			expect(tiktokBuy).toHaveBeenCalledWith("577", box, "r", ["u1", "u2"]);
			const [attempt] = await db.select().from(schema.labelAttempts);
			expect(attempt).toMatchObject({
				unitIds: ["u1", "u2"],
				state: "succeeded",
			});
		});

		test("TikTok holding other than the box stops the purchase before money is spent", async () => {
			const a = await tiktokOrder();
			const buyer = vi.fn();
			await expect(
				buy([a], 1, fakes({ tiktokUnits: units(["u1"]), tiktokBuy: buyer })),
			).rejects.toThrow("changed since it was packed");
			expect(buyer).not.toHaveBeenCalled();
			expect(await db.select().from(schema.labelAttempts)).toEqual([]);
		});

		test("an unanswered package is found only through its own units", async () => {
			const a = await tiktokOrder();
			const lost = vi.fn(async () => {
				throw new Error("socket hang up");
			});
			const bought = await buy(
				[a],
				1,
				fakes({ tiktokUnits: units(["u1", "u2"]), tiktokBuy: lost }),
			);
			const findTiktok = vi.fn(async () => found("pkg-1"));
			const r = await checkLabelAttempt(db, bought.unsure as string, {
				lock,
				findShippo: vi.fn(),
				findTiktok,
			});
			expect(findTiktok).toHaveBeenCalledWith("577", ["u1", "u2"]);
			expect(r.attempt.state).toBe("succeeded");
		});
	});
});
