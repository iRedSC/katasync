import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import * as schema from "#/db/capability-schema";
import type { Db } from "#/db/client";
import { type ChannelOrder, ingestOrder } from "#/orders/ingest";
import { reconcileStock } from "#/orders/reconcile-stock";
import { postMovements } from "./ledger";
import { setRecipe } from "./recipes";

const url = process.env.TEST_POSTGRES_URL;
if (process.env.CI && !url)
	throw new Error(
		"TEST_POSTGRES_URL is not set, so inventory locks go untested",
	);

function gate() {
	let release = () => {};
	const ready = new Promise<void>((resolve) => {
		release = resolve;
	});
	return { ready, release };
}

function observed(client: Client, onQuery: (text: string) => Promise<void>) {
	const proxy = new Proxy(client, {
		get(target, property, receiver) {
			if (property !== "query") return Reflect.get(target, property, receiver);
			return async (...args: unknown[]) => {
				const result: unknown = await Reflect.apply(target.query, target, args);
				const query = args[0];
				const text =
					typeof query === "string"
						? query
						: typeof query === "object" && query !== null && "text" in query
							? String(query.text)
							: "";
				await onQuery(text);
				return result;
			};
		},
	});
	return drizzle(proxy, { schema, casing: "snake_case" });
}

describe.skipIf(!url)("inventory product lock ordering", () => {
	const database = `kata_locks_${randomUUID().replaceAll("-", "")}`;
	let admin: Client;
	let first: Client;
	let second: Client;
	let db: Db;
	let secondPid: number;
	let store: typeof schema.stores.$inferSelect;
	let locationId: number;
	let sequence = 0;

	beforeAll(async () => {
		admin = new Client({ connectionString: url });
		await admin.connect();
		await admin.query(`create database "${database}"`);
		const connection = new URL(url ?? "");
		connection.pathname = `/${database}`;
		first = new Client({ connectionString: connection.toString() });
		second = new Client({ connectionString: connection.toString() });
		await Promise.all([first.connect(), second.connect()]);
		const {
			rows: [{ pid }],
		} = await second.query<{ pid: number }>("select pg_backend_pid() as pid");
		secondPid = pid;
		db = drizzle(first, { schema, casing: "snake_case" });
		await migrate(drizzle(first, { casing: "snake_case" }), {
			migrationsFolder: "drizzle",
		});
		await first.query("set statement_timeout = '10s'");
		await second.query("set statement_timeout = '10s'");
		[store] = await db
			.insert(schema.stores)
			.values({ channel: "shopify", name: "Locks", stockFrom: new Date(0) })
			.returning();
		const [location] = await db
			.insert(schema.locations)
			.values({ name: "Locks", kind: "owned" })
			.returning();
		locationId = location.id;
	}, 60000);

	afterAll(async () => {
		await Promise.all([first?.end(), second?.end()]);
		if (admin) {
			await admin.query(`drop database if exists "${database}"`);
			await admin.end();
		}
	});

	const stock = () => ({
		shipping: locationId,
		store: null,
		pos: null,
		storeKeeps: 0,
	});
	const otherDb = () => drizzle(second, { schema, casing: "snake_case" });
	async function product(kind: "simple" | "bundle" = "simple") {
		const sku = `LOCK-${++sequence}`;
		const [row] = await db
			.insert(schema.products)
			.values({ sku, name: sku, kind })
			.returning();
		return row;
	}
	function order(skus: string[]): ChannelOrder {
		return {
			externalId: `lock-order-${++sequence}`,
			name: `Lock ${sequence}`,
			salesChannel: null,
			marketplaceOrderId: null,
			placedAt: new Date("2026-10-01"),
			sourceUpdatedAt: new Date("2026-10-01"),
			cancelledAt: null,
			fulfillmentStatus: "UNFULFILLED",
			fulfilledByChannel: false,
			soldInStore: false,
			financialStatus: "PAID",
			customerName: null,
			buyerId: null,
			shipAddress1: null,
			shipAddress2: null,
			shipCity: null,
			shipRegion: null,
			shipPostalCode: null,
			shipCountry: null,
			shipPhone: null,
			total: skus.length,
			shippingCharged: 0,
			tax: { remittedBy: "seller", lines: [] },
			lines: skus.map((sku, index) => ({
				externalId: String(index),
				listingExternalId: null,
				sku,
				title: sku,
				quantity: 1,
				unitPrice: 1,
			})),
		};
	}

	async function waitUntilBlocked() {
		const until = Date.now() + 5000;
		while (Date.now() < until) {
			const {
				rows: [{ blocked }],
			} = await admin.query<{ blocked: boolean }>(
				"select cardinality(pg_blocking_pids($1)) > 0 as blocked",
				[secondPid],
			);
			if (blocked) return;
			await new Promise((resolve) => setTimeout(resolve, 10));
		}
		throw new Error("The competing inventory writer did not reach its lock");
	}

	test("parallel ingests prelock products before order-line foreign keys", async () => {
		const item = await product();
		await postMovements(db, {
			lines: [
				{
					productId: item.id,
					locationId,
					delta: 10,
					reason: "opening_balance",
				},
			],
		});
		const inserted = gate();
		const continueFirst = gate();
		const firstDb = observed(first, async (text) => {
			if (text.startsWith('insert into "order_lines"')) {
				inserted.release();
				await continueFirst.ready;
			}
		});
		const one = ingestOrder(firstDb, store, order([item.sku]), stock());
		await inserted.ready;
		const two = ingestOrder(otherDb(), store, order([item.sku]), stock());
		try {
			await waitUntilBlocked();
		} finally {
			continueFirst.release();
		}
		expect(
			(await Promise.all([one, two])).map((result) => result.problems),
		).toEqual([[], []]);
		const [level] = await db
			.select()
			.from(schema.stockLevels)
			.where(eq(schema.stockLevels.productId, item.id));
		expect(level.onHand).toBe(8);
	}, 20000);

	test("a reversed multi-line ingest cannot lock a later product ahead of a recipe edit", async () => {
		const low = await product();
		const high = await product();
		const bundle = await product("bundle");
		await setRecipe(db, bundle.id, [
			{ productId: low.id, quantity: 1 },
			{ productId: high.id, quantity: 1 },
		]);
		await postMovements(db, {
			lines: [low, high].map((item) => ({
				productId: item.id,
				locationId,
				delta: 10,
				reason: "opening_balance" as const,
			})),
		});
		const inserted = gate();
		const continueFirst = gate();
		const firstDb = observed(first, async (text) => {
			if (text.startsWith('insert into "order_lines"')) {
				inserted.release();
				await continueFirst.ready;
			}
		});
		const sale = ingestOrder(
			firstDb,
			store,
			order([high.sku, low.sku]),
			stock(),
		);
		await inserted.ready;
		const edited = setRecipe(otherDb(), bundle.id, [
			{ productId: low.id, quantity: 2 },
			{ productId: high.id, quantity: 1 },
		]);
		try {
			await waitUntilBlocked();
		} finally {
			continueFirst.release();
		}
		await Promise.all([sale, edited]);
	}, 20000);

	test("reconciliation releases one line's products before taking the next", async () => {
		const low = await product();
		const high = await product();
		const bundle = await product("bundle");
		await setRecipe(db, bundle.id, [
			{ productId: low.id, quantity: 1 },
			{ productId: high.id, quantity: 1 },
		]);
		await ingestOrder(db, store, order([high.sku, low.sku]), {
			...stock(),
			shipping: null,
		});
		const posted = gate();
		const continueFirst = gate();
		let paused = false;
		const firstDb = observed(first, async (text) => {
			if (
				!paused &&
				text.startsWith('update "order_lines" set "sale_batch_id"')
			) {
				paused = true;
				posted.release();
				await continueFirst.ready;
			}
		});
		const settled = reconcileStock(firstDb, stock(), { channel: "shopify" });
		await posted.ready;
		const edited = setRecipe(otherDb(), bundle.id, [
			{ productId: low.id, quantity: 2 },
			{ productId: high.id, quantity: 1 },
		]);
		try {
			await waitUntilBlocked();
		} finally {
			continueFirst.release();
		}
		expect(await settled).toEqual({ lines: 2, problems: [] });
		await edited;
	}, 20000);
});
