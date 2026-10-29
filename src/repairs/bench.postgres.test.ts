import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import * as schema from "#/db/capability-schema";
import { repairs } from "#/db/repair-schema";
import { postMovements, recordSale } from "#/inventory/ledger";
import { receiveReturn } from "#/orders/returns";
import { lockDatabase } from "#/test/locks";
import { listBench, startBench } from "./bench";
import { moveRepair, setPart } from "./repairs";

const url = process.env.TEST_POSTGRES_URL;
if (process.env.CI && !url)
	throw new Error(
		"TEST_POSTGRES_URL is not set, so bench listing goes untested",
	);

describe.skipIf(!url)("bench listing lock ordering", () => {
	const pg = lockDatabase(url ?? "");
	let warehouse: number;
	let sequence = 0;
	beforeAll(async () => {
		await pg.open();
		await pg.db
			.insert(schema.stores)
			.values({ channel: "shopify", name: "Shop" });
		[{ id: warehouse }] = await pg.db
			.insert(schema.locations)
			.values({ name: "Warehouse", kind: "owned" })
			.returning();
	}, 60000);
	afterAll(() => pg.close());

	async function product(
		values: Partial<typeof schema.products.$inferInsert> = {},
	) {
		const sku = `BENCH-${++sequence}`;
		const [row] = await pg.db
			.insert(schema.products)
			.values({ sku, name: sku, kind: "simple", ...values })
			.returning();
		await postMovements(pg.db, {
			lines: [
				{
					productId: row.id,
					locationId: warehouse,
					delta: 3,
					reason: "opening_balance",
				},
			],
		});
		return row;
	}

	// A tool and a refurb of it, with stock.
	async function tool() {
		const original = await product();
		const refurb = await product({
			refurbishedFromId: original.id,
			condition: "good",
		});
		return { original, refurb };
	}

	// A shipped order of one of each, sold off the warehouse shelf.
	async function shipped(productIds: number[]) {
		const [store] = await pg.db.select().from(schema.stores).limit(1);
		const [order] = await pg.db
			.insert(schema.orders)
			.values({
				storeId: store.id,
				externalId: `bench-lock-${++sequence}`,
				name: `#${sequence}`,
				placedAt: new Date(),
				fulfillmentStatus: "FULFILLED",
				total: productIds.length,
				sourceUpdatedAt: new Date(),
			})
			.returning();
		const lines = [];
		for (const [index, productId] of productIds.entries()) {
			const [line] = await pg.db
				.insert(schema.orderLines)
				.values({
					orderId: order.id,
					externalId: String(index),
					productId,
					title: "Tool",
					quantity: 1,
					unitPrice: 1,
					unitCost: 1,
				})
				.returning();
			const { batchId } = await recordSale(pg.db, {
				productId,
				quantity: 1,
				locationId: warehouse,
				reference: `sale:${line.id}`,
			});
			await pg.db
				.update(schema.orderLines)
				.set({ saleBatchId: batchId })
				.where(eq(schema.orderLines.id, line.id));
			lines.push(line.id);
		}
		return { orderId: order.id, lines };
	}

	const productLock = (text: string) =>
		text.includes('from "products"') && /for (update|share)$/.test(text);

	test("a returned job takes its order before its parts, as receiving does", async () => {
		const { original, refurb } = await tool();
		const part = await product();
		const { orderId, lines } = await shipped([original.id, part.id]);
		const [id] = await startBench(pg.db, {
			orderId,
			lineId: lines[0],
			quantity: 1,
		});
		await setPart(pg.db, id, { toolId: null, productId: part.id, quantity: 1 });
		// Receiving the part's line holds the order, then wants the part.
		await pg.race(
			productLock,
			(db) => listBench(db, id, { kind: "add", productId: refurb.id }),
			(db) =>
				receiveReturn(db, {
					orderId,
					lines: [{ lineId: lines[1], quantity: 1 }],
					outcome: "restock",
				}),
		);
		const [job] = await pg.db.select().from(repairs).where(eq(repairs.id, id));
		expect(job.status).toBe("refurbished");
	}, 20000);

	test("listing one job waits for reopening another on its order", async () => {
		const { original, refurb } = await tool();
		const { orderId, lines } = await shipped([original.id, original.id]);
		const [listed] = await startBench(pg.db, {
			orderId,
			lineId: lines[0],
			quantity: 1,
		});
		const [reopened] = await startBench(pg.db, {
			orderId,
			lineId: lines[1],
			quantity: 1,
		});
		await moveRepair(pg.db, reopened, "cancelled");
		// Reopening holds the order, then locks the listed job's column.
		await pg.race(
			(text) => text.includes('from "repairs"') && text.endsWith("for update"),
			(db) => listBench(db, listed, { kind: "add", productId: refurb.id }),
			(db) => moveRepair(db, reopened, "received", listed),
		);
		const jobs = await pg.db.select().from(repairs);
		expect(jobs.find((j) => j.id === listed)?.status).toBe("refurbished");
		expect(jobs.find((j) => j.id === reopened)?.status).toBe("received");
	}, 20000);

	test("two jobs adding to one refurb take turns instead of both upgrading a share lock", async () => {
		const { original, refurb } = await tool();
		const [one] = await startBench(pg.db, { productId: original.id });
		const [two] = await startBench(pg.db, { productId: original.id });
		const into = { kind: "add" as const, productId: refurb.id };
		await pg.race(
			productLock,
			(db) => listBench(db, one, into),
			(db) => listBench(db, two, into),
		);
		const [{ onHand }] = await pg.db
			.select({ onHand: schema.stockLevels.onHand })
			.from(schema.stockLevels)
			.where(eq(schema.stockLevels.productId, refurb.id));
		expect(onHand).toBe(5);
	}, 20000);
});
