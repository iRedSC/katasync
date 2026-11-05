import { randomUUID } from "node:crypto";
import { Client } from "pg";
import {
	afterAll,
	beforeAll,
	beforeEach,
	describe,
	expect,
	test,
} from "vitest";
import { migrateDatabase } from "../../scripts/migrate-database";

// Two purchases of one order at once, each on its own connection, as two
// packers (or a double press past the app's advisory lock) would make them.
// drizzle/0182's triggers lock the order and the order line, so the second
// waits for the first and then sees it. PGlite has one session and can't
// show this, so it runs against a real server: CI starts one, and locally it
// runs when TEST_POSTGRES_URL is set.
const url = process.env.TEST_POSTGRES_URL;
if (process.env.CI && !url)
	throw new Error(
		"TEST_POSTGRES_URL is not set, so packing the same units twice goes untested",
	);

describe.skipIf(!url)("packing one order from two connections", () => {
	const database = `kata_packable_${randomUUID().replaceAll("-", "")}`;
	let admin: Client;
	let first: Client;
	let second: Client;
	let orderId: number;
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
		await migrateDatabase(first);
		for (const c of [first, second])
			await c.query("set statement_timeout = '10s'");
	}, 60000);

	afterAll(async () => {
		await Promise.all([first?.end(), second?.end()]);
		if (admin) {
			await admin.query(`drop database if exists "${database}"`);
			await admin.end();
		}
	});

	// A fresh order each test: one line of 2, none shipped.
	beforeEach(async () => {
		const n = ++sequence;
		const {
			rows: [store],
		} = await first.query<{ id: number }>(
			`insert into stores (channel, name) values ('shopify', $1) returning id`,
			[`Store ${n}`],
		);
		const {
			rows: [order],
		} = await first.query<{ id: number }>(
			`insert into orders (store_id, external_id, name, placed_at, fulfillment_status, total, source_updated_at)
			 values ($1, $2, $2, now(), 'UNFULFILLED', 20, now()) returning id`,
			[store.id, `order-${n}`],
		);
		orderId = order.id;
		await first.query(
			`insert into order_lines (order_id, external_id, title, quantity, shipped_quantity, unit_price)
			 values ($1, 'L1', 'Wrench', 2, 0, 10)`,
			[orderId],
		);
	});

	const newDispatch = async (c: Client) =>
		(
			await c.query<{ id: number }>(
				`insert into dispatches (contents_key, contents, box_count) values ('WRENCH', 'packed', 1) returning id`,
			)
		).rows[0].id;
	const join = (c: Client, dispatchId: number) =>
		c.query(
			"insert into dispatch_orders (dispatch_id, order_id) values ($1, $2)",
			[dispatchId, orderId],
		);
	const pack = (c: Client, dispatchId: number, quantity: number) =>
		c.query(
			`insert into dispatch_lines (dispatch_id, order_id, line_external_id, title, quantity)
			 values ($1, $2, 'L1', 'Wrench', $3)`,
			[dispatchId, orderId, quantity],
		);
	// The first box's purchase, saved with the dispatch as buyDispatch does.
	const attempt = (c: Client, dispatchId: number) =>
		c.query(
			`insert into label_attempts (id, dispatch_id, box_index, provider, rate_id, box)
			 values ($1, $2, 0, 'shippo', 'rate', '{}')`,
			[randomUUID(), dispatchId],
		);
	const settles = (p: Promise<unknown>, ms = 300) =>
		Promise.race([
			p.then(
				() => true,
				() => true,
			),
			new Promise<boolean>((r) => setTimeout(() => r(false), ms)),
		]);
	const reason = (p: Promise<unknown>) =>
		p.then(
			() => null,
			(e: Error) => e.message,
		);

	test("a second dispatch for the order waits for the first, then is refused", async () => {
		await first.query("begin");
		const a = await newDispatch(first);
		await join(first, a);
		await pack(first, a, 2);
		await attempt(first, a);

		await second.query("begin");
		const b = await newDispatch(second);
		const joining = join(second, b);
		// Held on the order's row until the first commits.
		expect(await settles(joining)).toBe(false);
		await first.query("commit");
		expect(await reason(joining)).toContain(
			"already has a label not yet handed off",
		);
		await second.query("rollback");
	});

	test("units packed by one are never packed by the other", async () => {
		// The second joined before the first had a label, so only the line
		// check stands between them.
		// A packed dispatch needs a line of its own to commit.
		await first.query(
			`insert into order_lines (order_id, external_id, title, quantity, shipped_quantity, unit_price)
			 values ($1, 'L2', 'Knife', 1, 0, 10)`,
			[orderId],
		);
		await second.query("begin");
		const b = await newDispatch(second);
		await join(second, b);
		await second.query(
			`insert into dispatch_lines (dispatch_id, order_id, line_external_id, title, quantity)
			 values ($1, $2, 'L2', 'Knife', 1)`,
			[b, orderId],
		);
		await second.query("commit");

		await first.query("begin");
		const a = await newDispatch(first);
		await join(first, a);
		await pack(first, a, 2);
		await attempt(first, a);

		await second.query("begin");
		const packing = pack(second, b, 1);
		// Held on the order line's row until the first commits.
		expect(await settles(packing)).toBe(false);
		await first.query("commit");
		expect(await reason(packing)).toContain("fewer than 1 units left to pack");
		await second.query("rollback");
	});
});
