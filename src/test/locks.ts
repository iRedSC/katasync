import { randomUUID } from "node:crypto";
import { drizzle } from "drizzle-orm/node-postgres";
import { Client } from "pg";
import * as schema from "#/db/capability-schema";
import type { Db } from "#/db/client";
import { migrateDatabase } from "../../scripts/migrate-database";

// For tests of lock order: two connections to a fresh database on a real
// Postgres server, since PGlite's single session can't show one transaction
// waiting on another. CI starts one (.github/workflows/test.yml); locally
// these run when TEST_POSTGRES_URL is set. The first connection is paused
// at a statement while the second competes for its locks.

export function gate() {
	let release = () => {};
	const ready = new Promise<void>((resolve) => {
		release = resolve;
	});
	return { ready, release };
}

// The client as a Db that calls onQuery after each statement, before the
// next can run.
export function observed(
	client: Client,
	onQuery: (text: string) => Promise<void>,
) {
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

// Resolves once the backend `pid` waits on another's lock.
export async function waitUntilBlocked(admin: Client, pid: number) {
	const until = Date.now() + 5000;
	while (Date.now() < until) {
		const {
			rows: [{ blocked }],
		} = await admin.query<{ blocked: boolean }>(
			"select cardinality(pg_blocking_pids($1)) > 0 as blocked",
			[pid],
		);
		if (blocked) return;
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	throw new Error("The competing writer did not reach its lock");
}

// A fresh migrated database: `db` on the first connection, `other` on the
// second. `pauseAt(match)` gives the first connection as a Db that stops
// after the first statement `match` accepts, until the competitor waits
// on it; `race` runs the two that way and settles both.
export function lockDatabase(url: string) {
	const database = `kata_locks_${randomUUID().replaceAll("-", "")}`;
	let admin: Client;
	let first: Client;
	let second: Client;
	let secondPid = 0;
	const fixture = {
		db: undefined as unknown as Db,
		other: undefined as unknown as Db,
		async open() {
			admin = new Client({ connectionString: url });
			await admin.connect();
			await admin.query(`create database "${database}"`);
			const connection = new URL(url);
			connection.pathname = `/${database}`;
			first = new Client({ connectionString: connection.toString() });
			second = new Client({ connectionString: connection.toString() });
			await Promise.all([first.connect(), second.connect()]);
			const {
				rows: [{ pid }],
			} = await second.query<{ pid: number }>("select pg_backend_pid() as pid");
			secondPid = pid;
			fixture.db = drizzle(first, { schema, casing: "snake_case" });
			fixture.other = drizzle(second, { schema, casing: "snake_case" });
			await migrateDatabase(first);
			await first.query("set statement_timeout = '10s'");
			await second.query("set statement_timeout = '10s'");
		},
		async close() {
			await Promise.all([first?.end(), second?.end()]);
			if (admin) {
				await admin.query(`drop database if exists "${database}"`);
				await admin.end();
			}
		},
		// Runs `paused` on the first connection until a statement `match`
		// accepts has run, then `competing` on the second until it waits for
		// a lock, then lets both finish. A deadlock fails one of them.
		async race<A, B>(
			match: (text: string) => boolean,
			paused: (db: Db) => Promise<A>,
			competing: (db: Db) => Promise<B>,
		): Promise<[A, B]> {
			const reached = gate();
			const proceed = gate();
			let seen = false;
			const firstDb = observed(first, async (text) => {
				if (!seen && match(text)) {
					seen = true;
					reached.release();
					await proceed.ready;
				}
			});
			const one = paused(firstDb);
			await Promise.race([reached.ready, one]);
			if (!seen) throw new Error("The first writer never reached its pause");
			const two = competing(fixture.other);
			try {
				await waitUntilBlocked(admin, secondPid);
			} catch (error) {
				proceed.release();
				await Promise.allSettled([one, two]);
				throw error;
			}
			proceed.release();
			return Promise.all([one, two]);
		},
	};
	return fixture;
}
