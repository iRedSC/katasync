import { PGlite } from "@electric-sql/pglite";
import { readMigrationFiles } from "drizzle-orm/migrator";
import { expect, test } from "vitest";

test("dispatch migrations preserve existing labels and handoffs", async () => {
	const client = new PGlite();
	try {
		const migrations = readMigrationFiles({ migrationsFolder: "drizzle" });
		const dispatchStart = migrations.findIndex((migration) =>
			migration.sql.some((statement) =>
				statement.includes('CREATE TABLE "dispatches"'),
			),
		);
		if (dispatchStart < 0) throw new Error("Dispatch migration not found");
		for (const migration of migrations.slice(0, dispatchStart)) {
			for (const statement of migration.sql) await client.exec(statement);
		}
		const { rows: stores } = await client.query<{ id: number }>(
			"insert into stores (channel, name) values ('shopify', 'Shop') returning id",
		);
		const { rows: orders } = await client.query<{ id: number }>(
			"insert into orders (store_id, external_id, name, placed_at, fulfillment_status, total, source_updated_at) values ($1, 'order-1', '#1', now(), 'FULFILLED', 30, now()) returning id",
			[stores[0].id],
		);
		await client.query(
			"insert into shipments (id, order_id, contents_key, length_mm, width_mm, height_mm, weight_grams, provider, carrier, service, service_name, cost, external_id, test, channel_sent_at, channel_fulfillment_id, label_pdf, created_at) overriding system value values (17, $1, 'WRENCH×2', 300, 200, 100, 600, 'shippo', 'USPS', 'ground', 'Ground', 7, 'tx-old', false, '2026-10-12T12:00:00Z', 'fulfillment-old', decode('0102ff', 'hex'), '2026-10-12T11:00:00Z')",
			[orders[0].id],
		);
		for (const migration of migrations.slice(dispatchStart)) {
			for (const statement of migration.sql) await client.exec(statement);
		}
		const { rows: labels } = await client.query<{
			dispatch_id: number;
			external_id: string;
			label_pdf: Uint8Array;
		}>(
			"select dispatch_id, external_id, label_pdf from shipments where id = 17",
		);
		expect(labels[0].dispatch_id).toBe(17);
		expect(labels[0].external_id).toBe("tx-old");
		expect([...labels[0].label_pdf]).toEqual([1, 2, 255]);
		const { rows: handoffs } = await client.query<{
			order_id: number;
			channel_sent_at: Date;
			channel_fulfillment_id: string;
		}>(
			"select order_id, channel_sent_at, channel_fulfillment_id from dispatch_orders where dispatch_id = 17",
		);
		expect(handoffs[0].order_id).toBe(orders[0].id);
		expect(handoffs[0].channel_sent_at.toISOString()).toBe(
			"2026-10-12T12:00:00.000Z",
		);
		expect(handoffs[0].channel_fulfillment_id).toBe("fulfillment-old");
		const { rows: dispatches } = await client.query<{
			contents_key: string;
			bought_at: Date;
			contents: string;
			box_count: number | null;
		}>(
			"select contents_key, bought_at, contents, box_count from dispatches where id = 17",
		);
		expect(dispatches[0].contents_key).toBe("WRENCH×2");
		expect(dispatches[0].contents).toBe("unknown");
		expect(dispatches[0].box_count).toBeNull();
		const { rows: lines } = await client.query(
			"select * from dispatch_lines where dispatch_id = 17",
		);
		expect(lines).toEqual([]);
		expect(dispatches[0].bought_at.toISOString()).toBe(
			"2026-10-12T11:00:00.000Z",
		);
		const { rows: next } = await client.query<{ id: number }>(
			"insert into dispatches (contents_key) values ('NEXT') returning id",
		);
		expect(next[0].id).toBe(18);
	} finally {
		await client.close();
	}
});
