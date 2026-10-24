import { asc, eq, inArray } from "drizzle-orm";
import { beforeEach, describe, expect, test } from "vitest";
import type { Db } from "#/db/client";
import { repairs } from "#/db/repair-schema";
import { createProduct, createTestDb } from "#/test/db";
import { createRepair, editRepair, moveRepair } from "./repairs";
import type { RepairStatus } from "./status";

let db: Db;
const customer = {
	id: "gid://shopify/Customer/1",
	name: "Ana",
	phone: null,
	email: null,
};

const make = () => createRepair(db, { customer, tool: "Taper" });

// A column's repairs, top first.
async function column(status: RepairStatus) {
	const rows = await db
		.select({ id: repairs.id })
		.from(repairs)
		.where(inArray(repairs.status, [status]))
		.orderBy(asc(repairs.position), asc(repairs.id));
	return rows.map((r) => r.id);
}

beforeEach(async () => {
	db = await createTestDb();
});

describe("the queue", () => {
	test("new ones go last, and a drop goes above the card it's dropped on", async () => {
		const [a, b, c] = [await make(), await make(), await make()];
		expect(await column("received")).toEqual([a, b, c]);
		await moveRepair(db, c, "received", a);
		expect(await column("received")).toEqual([c, a, b]);
		await moveRepair(db, c, "received", null);
		expect(await column("received")).toEqual([a, b, c]);
	});

	test("moved to another column it goes last there, or where it's dropped", async () => {
		const [a, b, c] = [await make(), await make(), await make()];
		await moveRepair(db, a, "in_repair");
		await moveRepair(db, b, "in_repair");
		expect(await column("in_repair")).toEqual([a, b]);
		await moveRepair(db, c, "in_repair", a);
		expect(await column("in_repair")).toEqual([c, a, b]);
		// Back where it came from, it's last again.
		await moveRepair(db, a, "received");
		expect(await column("received")).toEqual([a]);
	});

	test("dropping between the same two over and over still keeps them apart", async () => {
		const [a, b, c] = [await make(), await make(), await make()];
		for (let i = 0; i < 60; i++) {
			await moveRepair(db, c, "received", b);
			await moveRepair(db, b, "received", c);
		}
		const order = await column("received");
		expect(order[0]).toBe(a);
		expect(new Set(order).size).toBe(3);
		const positions = await db
			.select({ p: repairs.position })
			.from(repairs)
			.orderBy(asc(repairs.position));
		expect(new Set(positions.map((r) => r.p)).size).toBe(3);
	});
});

describe("the tool's product", () => {
	test("picked, it's kept; named anew without it, it's typed out", async () => {
		const taper = await createProduct(db, "TAPER", "simple");
		const id = await createRepair(db, {
			customer,
			tool: "Taper",
			productId: taper,
		});
		const productOf = async () =>
			(await db.select().from(repairs).where(eq(repairs.id, id)))[0].productId;
		expect(await productOf()).toBe(taper);
		await editRepair(db, id, { serial: "S1" });
		expect(await productOf()).toBe(taper);
		await editRepair(db, id, { tool: "Some other taper" });
		expect(await productOf()).toBeNull();
		await expect(editRepair(db, id, { productId: taper })).rejects.toThrow(
			/along with/,
		);
	});
});
