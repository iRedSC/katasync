import { sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { createTestDb } from "./db";

// The next test gets the schema back however this one changed it. These run
// in order on one worker, so each change is undone for the test after it.
describe("createTestDb", () => {
	const changes = [
		"alter table movements disable trigger movements_append_only",
		"create or replace function reject_movement_change() returns trigger as $$ begin return new; end $$ language plpgsql",
		"alter table products alter column name drop not null",
		"set session_replication_role = replica",
	];

	for (const change of changes) {
		it(`undoes: ${change}`, async () => {
			const db = await createTestDb();
			await db.execute(sql.raw(change));
		}, 30_000);

		it(`then is back as migrated after: ${change}`, async () => {
			const db = await createTestDb();
			const { rows } = (await db.execute(
				sql`select
				(select tgenabled from pg_trigger where tgname = 'movements_append_only') as enabled,
				(select prosrc from pg_proc where proname = 'reject_movement_change') as body,
				(select attnotnull from pg_attribute where attrelid = 'products'::regclass and attname = 'name') as notnull,
				current_setting('session_replication_role') as role`,
			)) as unknown as {
				rows: {
					enabled: string;
					body: string;
					notnull: boolean;
					role: string;
				}[];
			};
			expect(rows[0]).toMatchObject({
				enabled: "O",
				notnull: true,
				role: "origin",
			});
			expect(rows[0].body).not.toContain("return new");
		}, 30_000);
	}
});
