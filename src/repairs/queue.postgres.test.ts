import { asc, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { repairs } from "#/db/repair-schema";
import { lockDatabase } from "#/test/locks";
import { createRepair, moveRepair } from "./repairs";

const url = process.env.TEST_POSTGRES_URL;
if (process.env.CI && !url)
	throw new Error(
		"TEST_POSTGRES_URL is not set, so the repair queue goes untested",
	);

describe.skipIf(!url)("repair queue lock ordering", () => {
	const pg = lockDatabase(url ?? "");
	beforeAll(() => pg.open(), 60000);
	afterAll(() => pg.close());

	const customer = {
		id: "gid://shopify/Customer/1",
		name: "Ana",
		phone: null,
		email: null,
	};

	test("two drops in one column take turns instead of deadlocking", async () => {
		const make = () =>
			createRepair(pg.db, { customer, tools: [{ tool: "Taper" }] });
		const [a, b, c] = [await make(), await make(), await make()];
		// The first move pauses holding its repair; the second, holding
		// another, would wait on it to lock the column, and the first on it.
		await pg.race(
			(text) => text.includes('from "repairs"') && text.endsWith("for update"),
			(db) => moveRepair(db, c, "received", a),
			(db) => moveRepair(db, b, "received", a),
		);
		const column = await pg.db
			.select({ id: repairs.id })
			.from(repairs)
			.where(eq(repairs.status, "received"))
			.orderBy(asc(repairs.position), asc(repairs.id));
		expect(column.map((r) => r.id)).toEqual([c, b, a]);
	}, 20000);
});
