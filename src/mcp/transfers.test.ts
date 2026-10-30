import { and, eq } from "drizzle-orm";
import { beforeEach, describe, expect, test } from "vitest";
import type { Db } from "#/db/client";
import * as schema from "#/db/schema";
import { callTool, freshDb } from "./mcp.fixtures";

let db: Db;
let blade: number;
let fba: number;
beforeEach(async () => {
	({ db, blade } = await freshDb());
	[{ id: fba }] = await db
		.insert(schema.locations)
		.values({ name: "Amazon FBA", kind: "fba" })
		.returning();
});

const tool = (name: string, args: Record<string, unknown>) =>
	callTool(db, true, name, args);

async function onHand(locationName: string) {
	const [row] = await db
		.select({ onHand: schema.stockLevels.onHand })
		.from(schema.stockLevels)
		.innerJoin(
			schema.locations,
			eq(schema.locations.id, schema.stockLevels.locationId),
		)
		.where(
			and(
				eq(schema.stockLevels.productId, blade),
				eq(schema.locations.name, locationName),
			),
		);
	return row?.onHand ?? 0;
}

describe("sending stock to Amazon FBA over MCP", () => {
	beforeEach(async () => {
		await tool("record_count", { sku: "BLADE", counted: 10 });
	});

	test("transfer_stock takes it off the shelf, and undo_transfer puts it back", async () => {
		const moved = await tool("transfer_stock", {
			sku: "BLADE",
			quantity: 4,
			from: "Warehouse",
			to: "Amazon FBA",
		});
		expect(moved.isError).toBe(false);
		expect(await onHand("Warehouse")).toBe(6);
		expect(await onHand("Amazon FBA")).toBe(0);

		const id = Number(moved.data.transfer.slice(1));
		const seen = await tool("get_transfer", { transfer: id });
		expect(seen.data.delivery).toEqual({ kind: "sent_to_amazon" });
		await tool("undo_transfer", { transfer: id });
		expect(await onHand("Warehouse")).toBe(10);
	});

	test("a draft pointed at FBA sends with nothing to receive", async () => {
		const made = await tool("create_transfer", {
			to: "Amazon FBA",
			lines: [{ sku: "BLADE", quantity: 3 }],
		});
		expect(made.data.toLocationId).toBe(fba);
		const id = Number(made.data.transfer.slice(1));

		const swapped = await tool("edit_transfer", { transfer: id, swap: true });
		expect(swapped.isError).toBe(true);

		const sent = await tool("send_transfer", { transfer: id });
		expect(sent.data.status).toBe("sent");
		expect(sent.data.delivery).toEqual({ kind: "sent_to_amazon" });
		expect(await onHand("Warehouse")).toBe(7);
		expect(await onHand("Amazon FBA")).toBe(0);
	});

	test("edit_transfer can aim a draft at FBA", async () => {
		await db
			.insert(schema.locations)
			.values({ name: "Retail", kind: "retail" });
		const made = await tool("create_transfer", {
			lines: [{ sku: "BLADE", quantity: 2 }],
		});
		const id = Number(made.data.transfer.slice(1));
		const edited = await tool("edit_transfer", {
			transfer: id,
			to: "Amazon FBA",
		});
		expect(edited.data.toLocationId).toBe(fba);
	});
});
