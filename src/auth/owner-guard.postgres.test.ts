import { randomUUID } from "node:crypto";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Client } from "pg";
import {
	afterAll,
	beforeAll,
	beforeEach,
	describe,
	expect,
	test,
} from "vitest";
import * as schema from "#/db/capability-schema";
import { lockOwners } from "./authority";
import { addPerson } from "./staff.fixtures";

const url = process.env.TEST_POSTGRES_URL;
if (process.env.CI && !url)
	throw new Error("TEST_POSTGRES_URL is required to test owner isolation");

describe.skipIf(!url)("last usable owner across PostgreSQL snapshots", () => {
	const database = `kata_owners_${randomUUID().replaceAll("-", "")}`;
	let admin: Client;
	let first: Client;
	let second: Client;
	let secondPid: number;
	let firstId: string;
	let secondId: string;
	const firstDb = () => drizzle(first, { schema, casing: "snake_case" });
	const secondDb = () => drizzle(second, { schema, casing: "snake_case" });

	beforeAll(async () => {
		admin = new Client({ connectionString: url });
		await admin.connect();
		await admin.query(`create database "${database}"`);
		const connection = new URL(url ?? "");
		connection.pathname = `/${database}`;
		first = new Client({ connectionString: connection.toString() });
		second = new Client({ connectionString: connection.toString() });
		await Promise.all([first.connect(), second.connect()]);
		secondPid = (
			await second.query<{ pid: number }>("select pg_backend_pid() as pid")
		).rows[0].pid;
		await migrate(drizzle(first), { migrationsFolder: "drizzle" });
		await first.query("set statement_timeout = '10s'");
		await second.query("set statement_timeout = '10s'");
	}, 60000);

	beforeEach(async () => {
		await Promise.all([first.query("rollback"), second.query("rollback")]);
		await first.query("set session_replication_role = replica");
		await first.query("truncate staff, passkeys cascade");
		await first.query("set session_replication_role = origin");
		firstId = (await addPerson(firstDb(), "First", "owner", ["first-key"]))
			.staffId;
		secondId = (await addPerson(firstDb(), "Second", "owner", ["second-key"]))
			.staffId;
		await Promise.all([
			first.query("begin isolation level repeatable read"),
			second.query("begin isolation level repeatable read"),
		]);
		await Promise.all([
			first.query("select * from staff"),
			second.query("select * from staff"),
		]);
	});

	afterAll(async () => {
		await Promise.all([first?.end(), second?.end()]);
		if (admin) {
			await admin.query(`drop database if exists "${database}"`);
			await admin.end();
		}
	});

	async function settleConflict(other: Promise<unknown>) {
		const failed = expect(other).rejects.toMatchObject({ code: "40001" });
		try {
			const deadline = Date.now() + 5000;
			while (true) {
				const {
					rows: [state],
				} = await admin.query<{ blocked: boolean }>(
					"select cardinality(pg_blocking_pids($1)) > 0 as blocked",
					[secondPid],
				);
				if (state.blocked) break;
				if (Date.now() > deadline)
					throw new Error("The competing owner writer did not wait");
				await new Promise((resolve) => setTimeout(resolve, 10));
			}
		} finally {
			await first.query("commit");
		}
		await failed;
		await second.query("rollback");
		expect(
			(
				await first.query<{ count: string }>(
					"select usable_owner_count() as count",
				)
			).rows[0].count,
		).toBe("1");
	}

	test("direct demotions cannot both commit against stale owner snapshots", async () => {
		await first.query("update staff set role = 'operator' where id = $1", [
			firstId,
		]);
		await settleConflict(
			second.query("update staff set role = 'operator' where id = $1", [
				secondId,
			]),
		);
	}, 20000);

	test("direct device deletions cannot remove both owners' final keys", async () => {
		await first.query("delete from passkeys where id = 'first-key'");
		await settleConflict(
			second.query("delete from passkeys where id = 'second-key'"),
		);
	}, 20000);

	test("the application guard also aborts a stale snapshot before authority checks", async () => {
		await lockOwners(firstDb());
		await first.query("update staff set role = 'operator' where id = $1", [
			firstId,
		]);
		const other = Promise.resolve(lockOwners(secondDb())).catch(
			(error: unknown) => {
				throw error && typeof error === "object" && "cause" in error
					? error.cause
					: error;
			},
		);
		await settleConflict(other);
	}, 20000);
});
