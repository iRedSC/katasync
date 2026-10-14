import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import type { Db } from "#/db/client";
import * as schema from "#/db/schema";

// Migrating takes about a second, so do it once per test file and hand each
// test a fresh clone.
let migrated: Promise<PGlite> | undefined;

export async function createTestDb(): Promise<Db> {
	migrated ??= (async () => {
		const pg = new PGlite();
		await migrate(drizzle(pg, { casing: "snake_case" }), {
			migrationsFolder: "drizzle",
		});
		return pg;
	})();
	const clone = (await (await migrated).clone()) as PGlite;
	return drizzle(clone, { schema, casing: "snake_case" });
}

export async function createProduct(
	db: Db,
	code: string,
	kind: "simple" | "kit" | "bundle",
) {
	const [row] = await db
		.insert(schema.products)
		.values({ sku: code, name: code, kind })
		.returning();
	return row.id;
}

// A shipment of these orders, as if quick ship bought it: one dispatch with
// a label per box. Each box starts as a sent-nowhere USPS label; pass
// overrides per box. Returns the dispatch and its boxes' ids.
export async function addDispatch(
	db: Db,
	input: {
		orderIds: number[];
		contentsKey?: string;
		createdAt?: Date;
		// False for a purchase that stopped part way.
		bought?: boolean;
		boxes?: Partial<typeof schema.shipments.$inferInsert>[];
	},
) {
	const [dispatch] = await db
		.insert(schema.dispatches)
		.values({
			contentsKey: input.contentsKey ?? "WRENCH×2",
			boughtAt: input.bought === false ? null : (input.createdAt ?? new Date()),
			...(input.createdAt ? { createdAt: input.createdAt } : {}),
		})
		.returning();
	await db
		.insert(schema.dispatchOrders)
		.values(
			input.orderIds.map((orderId) => ({ dispatchId: dispatch.id, orderId })),
		);
	const boxes = await db
		.insert(schema.shipments)
		.values(
			(input.boxes ?? [{}]).map((box, i) => ({
				dispatchId: dispatch.id,
				lengthMm: 300,
				widthMm: 200,
				heightMm: 100,
				weightGrams: 600,
				provider: "shippo",
				carrier: "USPS",
				service: "usps_ground_advantage",
				serviceName: "USPS Ground Advantage",
				cost: 7.08,
				trackingNumber: `940010000000000000000${i}`,
				trackingUrl: "https://tools.usps.com/x",
				labelUrl: "https://example.com/label.pdf",
				externalId: `tx-${dispatch.id}-${i}-${Math.random()}`,
				test: false,
				...(input.createdAt ? { createdAt: input.createdAt } : {}),
				...box,
			})),
		)
		.returning({ id: schema.shipments.id });
	return { dispatchId: dispatch.id, boxIds: boxes.map((b) => b.id) };
}
