import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, test } from "vitest";
import type { Db } from "#/db/client";
import * as schema from "#/db/schema";
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
});
