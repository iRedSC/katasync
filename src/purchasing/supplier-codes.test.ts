import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, test } from "vitest";
import type { Db } from "#/db/client";
import * as schema from "#/db/schema";
import { createPurchasingDb } from "./purchasing.fixtures";
import { supplierByRef, updateSupplier } from "./suppliers";

let db: Db;
let canam: number;
beforeEach(async () => {
	({ db, canam } = await createPurchasingDb());
	await db
		.insert(schema.suppliers)
		.values({ code: "FCI", name: "Full Circle International INC" });
});

async function codeOf(id: number) {
	const [s] = await db
		.select({ code: schema.suppliers.code })
		.from(schema.suppliers)
		.where(eq(schema.suppliers.id, id));
	return s?.code;
}

describe("a supplier's short name", () => {
	test("changes, trimmed, and finds the supplier after", async () => {
		await updateSupplier(db, canam, { code: " CA " });
		expect(await codeOf(canam)).toBe("CA");
		expect((await supplierByRef(db, "ca")).id).toBe(canam);
	});

	test("refuses blank, and one that would find another supplier", async () => {
		const before = await codeOf(canam);
		await expect(updateSupplier(db, canam, { code: "  " })).rejects.toThrow(
			"needs a short name",
		);
		await expect(updateSupplier(db, canam, { code: "fci" })).rejects.toThrow(
			"already goes by",
		);
		await expect(
			updateSupplier(db, canam, { code: "full circle international inc" }),
		).rejects.toThrow("already goes by");
		expect(await codeOf(canam)).toBe(before);
	});

	test("keeping its own is no conflict", async () => {
		const own = await codeOf(canam);
		await updateSupplier(db, canam, { code: own });
		expect(await codeOf(canam)).toBe(own);
	});
});
