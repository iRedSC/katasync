import { eq } from "drizzle-orm";
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

	test("counts stock and undoes it", async () => {
		const counted = await tool("record_count", { sku: "BLADE", counted: 7 });
		expect(counted.data).toMatchObject({ delta: 7, onHand: 7 });
		await tool("undo_stock_change", { batch_id: counted.data.batchId });
		const [level] = await db
			.select()
			.from(schema.stockLevels)
			.where(eq(schema.stockLevels.productId, blade));
		expect(level.onHand).toBe(0);
	});

	test("requested counts stay due until counted, and come back on undo", async () => {
		const due = async () =>
			(
				await db
					.select({
						requested: schema.stockLevels.countRequestedAt,
						counted: schema.stockLevels.lastCountedAt,
					})
					.from(schema.stockLevels)
					.where(eq(schema.stockLevels.productId, blade))
			).filter((l) => l.requested && (!l.counted || l.counted < l.requested))
				.length;
		const asked = await tool("request_counts", { skus: ["BLADE", "BLADE"] });
		expect(asked.data).toEqual({ requested: 1 });
		expect(await due()).toBe(1);
		const counted = await tool("record_count", { sku: "BLADE", counted: 3 });
		expect(await due()).toBe(0);
		await tool("undo_stock_change", { batch_id: counted.data.batchId });
		expect(await due()).toBe(1);
	});

	test("counts_due covers every shelf, narrows by filter, and drops what's counted", async () => {
		await createProduct(db, "GROOVE", "simple");
		await createProduct(db, "KIT-SET", "bundle");
		const due = async (args: Record<string, unknown> = {}) =>
			(await tool("counts_due", args)).data;

		// Never counted is stale; a tool set has no shelf.
		const all = await due();
		expect(all.shelves.map((s: { sku: string }) => s.sku).sort()).toEqual([
			"BLADE",
			"GROOVE",
		]);
		expect(all.byReason).toEqual({ oversold: 0, requested: 0, stale: 2 });

		await tool("request_counts", { skus: ["GROOVE"] });
		const next = await due();
		expect(next.shelves[0]).toMatchObject({
			sku: "GROOVE",
			reason: "requested",
			location: "Warehouse",
		});
		expect((await due({ reasons: ["stale"] })).shelves).toMatchObject([
			{ sku: "BLADE" },
		]);
		expect((await due({ search: "blad" })).due).toBe(1);

		await tool("record_count", { sku: "GROOVE", counted: 4 });
		expect((await due()).shelves.map((s: { sku: string }) => s.sku)).toEqual([
			"BLADE",
		]);

		const elsewhere = await tool("counts_due", { location: "Nowhere" });
		expect(elsewhere.isError).toBe(true);
	});
});
