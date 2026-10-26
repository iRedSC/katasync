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

	test("isn't ready below the supplier's minimum, and lists unpriced lines", async () => {
		const blade = await createProduct(db, "BLADE", "simple");
		const knife = await createProduct(db, "KNIFE", "simple");
		await supply(blade, 1);
		await supply(knife, null);
		await stock(knife, -1);
		await sell(blade, 90);
		// Unsold, so a C item: only marked critical does it go on the PO.
		await db
			.update(schema.products)
			.set({ critical: true })
			.where(eq(schema.products.id, knife));
		await db
			.update(schema.suppliers)
			.set({ criticalThreshold: 3 })
			.where(eq(schema.suppliers.id, canam));

		const [s] = await suggestPurchases(db, now);
		expect(s.lines.map((l) => l.sku)).toEqual(["BLADE", "KNIFE"]);
		// Blade is an A item: 90 sold in the cover days, none on the shelf, at
		// $1. Knife is one short of zero, so it's ordered back to one.
		expect(s).toMatchObject({ total: 90, unpriced: 1, readiness: "waiting" });
	});

	test("is ready below the minimum once enough critical products need it, and soon at twice that", async () => {
		const blade = await createProduct(db, "BLADE", "simple");
		const knife = await createProduct(db, "KNIFE", "simple");
		await supply(blade, 1);
		await supply(knife, 1);
		await sell(blade, 90); // an A item, so critical
		await stock(knife, -1);

		let [s] = await suggestPurchases(db, now);
		expect(s).toMatchObject({ critical: 1, readiness: "waiting" });

		await db
			.update(schema.products)
			.set({ critical: true })
			.where(eq(schema.products.id, knife));
		[s] = await suggestPurchases(db, now);
		// The supplier's threshold is 2 by default.
		expect(s).toMatchObject({ critical: 2, readiness: "ready" });

		await db
			.update(schema.suppliers)
			.set({ criticalThreshold: 1 })
			.where(eq(schema.suppliers.id, canam));
		[s] = await suggestPurchases(db, now);
		expect(s.readiness).toBe("soon");

		await db
			.update(schema.suppliers)
			.set({ criticalThreshold: 3 })
			.where(eq(schema.suppliers.id, canam));
		[s] = await suggestPurchases(db, now);
		expect(s.readiness).toBe("waiting");
	});
});
