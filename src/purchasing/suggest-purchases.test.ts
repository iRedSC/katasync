import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, test } from "vitest";
import type { Db } from "#/db/client";
import * as schema from "#/db/schema";
import { setRecipe } from "#/inventory/recipes";
import { createProduct } from "#/test/db";
import {
	createPurchasingDb,
	daysAgo,
	now,
	purchasingBuilders,
} from "./purchasing.fixtures";
import { suggestPurchases } from "./reorder";

let db: Db;
let warehouse: number;
let canam: number;
let store: number;
const { stock, sell, supply } = purchasingBuilders(() => ({
	db,
	warehouse,
	canam,
	store,
}));

beforeEach(async () => {
	({ db, warehouse, canam, store } = await createPurchasingDb());
});

describe("suggestPurchases", () => {
	test("counts tool sets as their parts and skips FBA and cancelled orders", async () => {
		const blade = await createProduct(db, "BLADE", "simple");
		const set = await createProduct(db, "SET", "bundle");
		await setRecipe(db, set, [{ productId: blade, quantity: 2 }]);
		await supply(blade, 5);

		await sell(blade, 30);
		await sell(set, 15); // 30 blades
		await sell(blade, 900, { fulfilledByChannel: true });
		await sell(blade, 900, { cancelledAt: now });
		await sell(blade, 900, { placedAt: daysAgo(91) });

		const [s] = await suggestPurchases(db, now);
		// 60 sold in the cover days (the set's 30 blades count as parts), none
		// on the shelf or on order: tops up to 60, at $5 each.
		expect(s.lines).toMatchObject([{ sku: "BLADE", sold: 60, quantity: 60 }]);
		expect(s).toMatchObject({
			total: 300,
			readiness: "ready",
			draftId: null,
		});
	});

	test("waits below the supplier's minimum while nothing loses profit, and leaves off what can't be valued", async () => {
		const blade = await createProduct(db, "BLADE", "simple");
		const knife = await createProduct(db, "KNIFE", "simple");
		await supply(blade, 1);
		// No cost anywhere, so no profit to weigh: only recommended.
		await supply(knife, null);
		await stock(knife, -1);
		await sell(knife, 5);
		await sell(blade, 90);
		// 1 a day: 20 on the shelf outlast the 10 day lead time plus a week.
		await stock(blade, 20);

		const [s] = await suggestPurchases(db, now);
		expect(s.lines.map((l) => l.sku)).toEqual(["BLADE"]);
		// Blade tops up to the 90 sold in the cover days, less the 20 there,
		// at $1.
		expect(s).toMatchObject({ total: 70, atRisk: 0, readiness: "waiting" });
	});

	test("shows a supplier under its minimum once waiting loses profit", async () => {
		const blade = await createProduct(db, "BLADE", "simple");
		await supply(blade, 1);
		// Sold out, so the week after a PO lands is lost. Few enough that the
		// PO stays under the $100 minimum.
		await sell(blade, 9);

		let [s] = await suggestPurchases(db, now);
		expect(s.readiness).toBe("short");
		expect(s.atRisk).toBeGreaterThan(0);

		await db
			.update(schema.suppliers)
			.set({ minimumOrder: 5 })
			.where(eq(schema.suppliers.id, canam));
		[s] = await suggestPurchases(db, now);
		expect(s.readiness).toBe("ready");
	});
});
