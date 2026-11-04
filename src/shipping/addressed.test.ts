import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, test, vi } from "vitest";
import type { Db } from "#/db/client";
import * as schema from "#/db/schema";
import { createTestDb } from "#/test/db";
import {
	type AddressedOutside,
	buyAddressed,
	voidAddressed,
} from "./addressed";
import { LabelRefused } from "./label-attempt-state";

let db: Db;

const to = {
	name: "Pat Doe",
	street1: "12 Oak St",
	street2: null,
	city: "Erie",
	state: "PA",
	zip: "16501",
};
const box = {
	packageId: null,
	lengthMm: 300,
	widthMm: 200,
	heightMm: 100,
	weightGrams: 600,
};
const ground = { carrier: "USPS", service: "ground", total: 7 };

function fakes(overrides: Partial<AddressedOutside> = {}): AddressedOutside {
	return {
		getRates: vi.fn(async () => ({
			rates: [
				{
					id: "g1",
					carrier: "USPS",
					service: "ground",
					serviceName: "USPS Ground Advantage",
					cost: 7,
					days: 3,
				},
			],
			notes: [],
		})),
		getRate: vi.fn(async (id: string) => ({
			id,
			carrier: "USPS",
			carrierToken: "usps",
			service: "ground",
			serviceName: "USPS Ground Advantage",
			cost: 7,
			days: 3,
		})),
		buyLabel: vi.fn(async () => ({
			id: "tx1",
			labelUrl: "https://example.com/l.pdf",
			trackingNumber: "9400111",
			trackingUrl: null,
		})),
		findLabel: vi.fn(async () => ({ kind: "none" as const })),
		refund: vi.fn(async () => ({ status: "QUEUED" })),
		isTest: () => false,
		...overrides,
	};
}

beforeEach(async () => {
	db = await createTestDb();
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

describe("buyAddressed", () => {
	test("buys one label and records who it went to, with no orders", async () => {
		const outside = fakes();
		const bought = await buyAddressed(
			db,
			{ attemptId: crypto.randomUUID(), to, box, choice: ground },
			outside,
		);
		if (bought.kind !== "bought") throw new Error("not bought");

		expect(outside.getRates).toHaveBeenCalledWith(
			expect.objectContaining({ to: { ...to, country: "US" } }),
		);
		const [dispatch] = await db
			.select()
			.from(schema.dispatches)
			.where(eq(schema.dispatches.id, bought.dispatchId));
		expect(dispatch.contents).toBe("addressed");
		expect(dispatch.sentTo).toEqual(to);
		expect(dispatch.boughtAt).not.toBeNull();
		expect(await db.select().from(schema.dispatchOrders)).toEqual([]);
		expect(bought).toMatchObject({ trackingNumber: "9400111", cost: 7 });
	});

	test("refuses a price above the one shown, before buying", async () => {
		const outside = fakes();
		await expect(
			buyAddressed(
				db,
				{
					attemptId: crypto.randomUUID(),
					to,
					box,
					choice: { ...ground, total: 6 },
				},
				outside,
			),
		).rejects.toThrow(/price went up/);
		expect(outside.buyLabel).not.toHaveBeenCalled();
		expect(await db.select().from(schema.dispatches)).toEqual([]);
	});

	test("a lost answer is reported as maybe bought", async () => {
		const outside = fakes({
			buyLabel: vi.fn(async () => {
				throw new Error("socket hang up");
			}),
		});
		const bought = await buyAddressed(
			db,
			{ attemptId: crypto.randomUUID(), to, box, choice: ground },
			outside,
		);
		expect(bought.kind).toBe("unsure");
		const [attempt] = await db.select().from(schema.labelAttempts);
		expect(attempt.state).toBe("unknown");
	});

	test("a refusal records nothing bought", async () => {
		const outside = fakes({
			buyLabel: vi.fn(async () => {
				throw new LabelRefused("Label not bought: bad address");
			}),
		});
		await expect(
			buyAddressed(
				db,
				{ attemptId: crypto.randomUUID(), to, box, choice: ground },
				outside,
			),
		).rejects.toThrow(/bad address/);
		expect(await db.select().from(schema.shipments)).toEqual([]);
	});
});

describe("sending the same purchase again", () => {
	test("returns the label already bought, without buying another", async () => {
		const outside = fakes();
		const send = { attemptId: crypto.randomUUID(), to, box, choice: ground };
		const first = await buyAddressed(db, send, outside);
		const again = await buyAddressed(db, send, outside);
		expect(again).toEqual(first);
		expect(outside.buyLabel).toHaveBeenCalledTimes(1);
		expect(await db.select().from(schema.shipments)).toHaveLength(1);
	});

	test("asks Shippo about a lost answer and records what it finds", async () => {
		const outside = fakes({
			buyLabel: vi.fn(async () => {
				throw new Error("socket hang up");
			}),
		});
		const send = { attemptId: crypto.randomUUID(), to, box, choice: ground };
		expect((await buyAddressed(db, send, outside)).kind).toBe("unsure");
		// Still nothing on Shippo: still unsure, still not bought again.
		expect((await buyAddressed(db, send, outside)).kind).toBe("unsure");

		outside.findLabel = vi.fn(async () => ({
			kind: "bought" as const,
			label: {
				externalId: "tx9",
				trackingNumber: "9400999",
				trackingUrl: null,
				labelUrl: "https://example.com/l.pdf",
				voided: null,
			},
		}));
		const found = await buyAddressed(db, send, outside);
		expect(found).toMatchObject({ kind: "bought", trackingNumber: "9400999" });
		expect(outside.buyLabel).toHaveBeenCalledTimes(1);
	});
});

describe("voidAddressed", () => {
	test("refunds the label once", async () => {
		const outside = fakes();
		const bought = await buyAddressed(
			db,
			{ attemptId: crypto.randomUUID(), to, box, choice: ground },
			outside,
		);
		if (bought.kind !== "bought") throw new Error("not bought");

		await voidAddressed(db, bought.dispatchId, outside);
		const [label] = await db.select().from(schema.shipments);
		expect(label.voidedAt).not.toBeNull();
		await expect(voidAddressed(db, bought.dispatchId, outside)).rejects.toThrow(
			/already voided/,
		);
		expect(outside.refund).toHaveBeenCalledTimes(1);
	});

	test("two voids at once ask for one refund", async () => {
		const outside = fakes();
		const bought = await buyAddressed(
			db,
			{ attemptId: crypto.randomUUID(), to, box, choice: ground },
			outside,
		);
		if (bought.kind !== "bought") throw new Error("not bought");
		const results = await Promise.allSettled([
			voidAddressed(db, bought.dispatchId, outside),
			voidAddressed(db, bought.dispatchId, outside),
		]);
		expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
		expect(outside.refund).toHaveBeenCalledTimes(1);
	});

	test("a refused refund leaves the label live to try again", async () => {
		const outside = fakes({
			refund: vi.fn(async () => {
				throw new Error("already scanned");
			}),
		});
		const bought = await buyAddressed(
			db,
			{ attemptId: crypto.randomUUID(), to, box, choice: ground },
			outside,
		);
		if (bought.kind !== "bought") throw new Error("not bought");
		await expect(voidAddressed(db, bought.dispatchId, outside)).rejects.toThrow(
			/scanned/,
		);
		const [label] = await db.select().from(schema.shipments);
		expect(label.voidedAt).toBeNull();
	});
});

test("an addressed package can never be given an order", async () => {
	const outside = fakes();
	const bought = await buyAddressed(
		db,
		{ attemptId: crypto.randomUUID(), to, box, choice: ground },
		outside,
	);
	if (bought.kind !== "bought") throw new Error("not bought");
	const [store] = await db
		.insert(schema.stores)
		.values({ channel: "shopify", name: "Shopify" })
		.returning();
	const [order] = await db
		.insert(schema.orders)
		.values({
			storeId: store.id,
			externalId: "#1",
			name: "#1",
			placedAt: new Date(),
			fulfillmentStatus: "UNFULFILLED",
			total: 30,
			sourceUpdatedAt: new Date(),
		})
		.returning();
	await expect(
		db
			.insert(schema.dispatchOrders)
			.values({ dispatchId: bought.dispatchId, orderId: order.id }),
	).rejects.toThrow();
});
