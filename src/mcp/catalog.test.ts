import { beforeEach, describe, expect, test } from "vitest";
import type { Db } from "#/db/client";
import * as schema from "#/db/schema";
import { createProduct } from "#/test/db";
import { callTool, freshDb } from "./mcp.fixtures";

let db: Db;
let blade: number;
beforeEach(async () => {
	({ db, blade } = await freshDb());
});

describe("over MCP", () => {
	let canWrite = true;
	beforeEach(() => {
		canWrite = true;
	});
	const tool = (name: string, args: Record<string, unknown>) =>
		callTool(db, canWrite, name, args);

	test("creates boxes all or none", async () => {
		const made = await tool("create_boxes", {
			boxes: [
				{ pin: 1, length_in: 3, width_in: 3, height_in: 6, weight_oz: 0 },
			],
		});
		expect(made.data).toEqual([{ pin: 1, name: "3 × 3 × 6" }]);
		const clash = await tool("create_boxes", {
			boxes: [
				{ pin: 2, length_in: 4, width_in: 4, height_in: 4, weight_oz: 1 },
				{ pin: 1, length_in: 5, width_in: 5, height_in: 5, weight_oz: 1 },
			],
		});
		expect(clash).toMatchObject({ isError: true });
		expect(clash.data).toMatch(/Pin 1 is already 3 × 3 × 6/);
		expect(await db.select().from(schema.packages)).toHaveLength(1);
	});

	test("changes product details, kit parts, and builds kits", async () => {
		const kit = await createProduct(db, "KIT", "kit");
		const product = await tool("update_product", {
			sku: "BLADE",
			unit_cost: 1.5,
			weight_oz: 2,
			barcode: "123",
		});
		expect(product.data).toMatchObject({
			unitCost: 1.5,
			weightGrams: 57,
			barcode: "123",
		});
		const dupe = await tool("update_product", { sku: "KIT", barcode: "123" });
		expect(dupe.data).toMatch(/already on BLADE/);

		await tool("set_components", {
			sku: "KIT",
			components: [{ sku: "BLADE", quantity: 2 }],
		});
		await tool("record_count", { sku: "BLADE", counted: 4 });
		const built = await tool("assemble_kits", { sku: "KIT", quantity: 2 });
		expect(built.isError).toBe(false);
		const short = await tool("assemble_kits", { sku: "KIT", quantity: 1 });
		expect(short.isError).toBe(true);
		const levels = await db.select().from(schema.stockLevels);
		expect(
			Object.fromEntries(levels.map((l) => [l.productId, l.onHand])),
		).toEqual({ [blade]: 0, [kit]: 2 });
	});
});
