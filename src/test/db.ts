import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { expect } from "vitest";
import type { Db } from "#/db/client";
import * as schema from "#/db/schema";

// Booting PGlite and migrating take seconds; wiping its tables takes about
// 0.1s. So each worker process boots and migrates once, kept on globalThis
// because test files reuse workers (vitest.config.ts turns off isolate), and
// every test gets the same database wiped back to just-migrated. Something
// a wipe can't undo, like a test's own trigger or a session left as another
// role, changes the fingerprint; the database is then reloaded from the
// copy saved after migrating.

type Shared = {
	pg: PGlite;
	// The just-migrated database, to reload from.
	dump: File | Blob;
	fingerprint: string;
	// Puts every table back as migrating left it.
	wipe: string;
	// The test the database was last handed to.
	handedTo?: string;
};

const key = Symbol.for("katasync.testDb");
const store = globalThis as { [key]?: Promise<Shared> };

// What a wipe leaves alone: the schema, and the session's role and settings.
// Definitions, not counts, so a trigger turned off or a function rewritten
// in place shows up too.
const FINGERPRINT = `select concat_ws(':',
	(select md5(coalesce(string_agg(t.tgrelid::regclass || t.tgname || t.tgenabled::text || t.tgfoid::regprocedure, ',' order by t.tgrelid::regclass::text, t.tgname), '')) from pg_trigger t where not t.tgisinternal),
	(select md5(coalesce(string_agg(p.oid::regprocedure || md5(p.prosrc), ',' order by p.oid::regprocedure::text), '')) from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public'),
	(select md5(coalesce(string_agg(a.attrelid::regclass || a.attname || a.atttypid::regtype || a.attnotnull::text || coalesce(pg_get_expr(d.adbin, d.adrelid), ''), ',' order by a.attrelid::regclass::text, a.attnum), '')) from pg_attribute a join pg_class c on c.oid = a.attrelid join pg_namespace n on n.oid = c.relnamespace left join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum where n.nspname = 'public' and a.attnum > 0 and not a.attisdropped),
	(select md5(coalesce(string_agg(c.conrelid::regclass || c.conname || pg_get_constraintdef(c.oid), ',' order by c.conrelid::regclass::text, c.conname), '')) from pg_constraint c join pg_namespace n on n.oid = c.connamespace where n.nspname = 'public'),
	(select md5(coalesce(string_agg(indexrelid::regclass::text, ',' order by indexrelid::regclass::text), '')) from pg_index i join pg_class c on c.oid = i.indrelid join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public'),
	current_user, session_user, current_setting('TimeZone'), current_setting('search_path'),
	current_setting('session_replication_role')
) as f`;

async function fingerprintOf(pg: PGlite) {
	const { rows } = await pg.query<{ f: string }>(FINGERPRINT);
	return rows[0].f;
}

// Truncating every table, with triggers off so append-only tables allow it,
// then copying back the rows migrations seed and setting each sequence back.
async function wipeFor(pg: PGlite) {
	const { rows: tables } = await pg.query<{ name: string }>(
		`select format('public.%I', tablename) as name from pg_tables where schemaname = 'public' order by 1`,
	);
	await pg.exec("create schema test_seed");
	const seeded: string[] = [];
	for (const { name } of tables) {
		const copy = name.replace(/^public\./, "test_seed.");
		await pg.exec(`create table ${copy} as select * from ${name}`);
		const { rows } = await pg.query<{ n: number }>(
			`select count(*)::int as n from ${copy}`,
		);
		if (rows[0].n > 0)
			seeded.push(
				`insert into ${name} overriding system value select * from ${copy};`,
			);
		else await pg.exec(`drop table ${copy}`);
	}
	const { rows: sequences } = await pg.query<{
		name: string;
		last: string | null;
	}>(
		`select format('%I.%I', schemaname, sequencename) as name, last_value::text as last from pg_sequences where schemaname = 'public'`,
	);
	const reset = sequences.map(({ name, last }) =>
		last === null
			? `alter sequence ${name} restart;`
			: `select setval('${name}', ${last});`,
	);
	return [
		"set session_replication_role = replica;",
		`truncate ${tables.map((t) => t.name).join(", ")} restart identity cascade;`,
		...seeded,
		...reset,
		"set session_replication_role = default;",
	].join("\n");
}

async function boot(): Promise<Shared> {
	const pg = new PGlite();
	await migrate(drizzle(pg, { casing: "snake_case" }), {
		migrationsFolder: "drizzle",
	});
	const wipe = await wipeFor(pg);
	return {
		pg,
		dump: await pg.dumpDataDir("none"),
		fingerprint: await fingerprintOf(pg),
		wipe,
	};
}

// One database per test: a second would wipe the first under it.
function claim(shared: Shared) {
	const { currentTestName, testPath } = expect.getState();
	const test = `${testPath} > ${currentTestName}`;
	if (currentTestName && shared.handedTo === test)
		throw new Error(
			"createTestDb was called twice in one test; the test database is shared, so the second would wipe the first. Use the first one.",
		);
	shared.handedTo = test;
}

export async function createTestDb(): Promise<Db> {
	store[key] ??= boot();
	const shared = await store[key];
	claim(shared);
	// A test that died inside a transaction leaves the session unusable, which
	// counts as changed too.
	const now = await fingerprintOf(shared.pg).catch(() => null);
	if (now !== shared.fingerprint) {
		await shared.pg.close();
		shared.pg = await PGlite.create({ loadDataDir: shared.dump });
	}
	await shared.pg.exec(shared.wipe);
	return drizzle(shared.pg, { schema, casing: "snake_case" });
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
