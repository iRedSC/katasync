import { sql } from "drizzle-orm";
import { type Db, withOwnConnection } from "#/db/client";

// Ad hoc SQL for the MCP query tool. Safe to hand to a model: Postgres itself
// refuses writes in a read-only transaction, the statement is sent with a
// parameter so Postgres takes exactly one statement (a "; delete ..." can't
// ride along), a time limit stops runaway queries, and it runs on a
// connection of its own so nothing it does to the session reaches the app's
// pool. That connection is the boundary; the checks below are a second line.

export class QueryError extends Error {
	name = "QueryError";
}

export const MAX_ROWS = 2000;
const TIMEOUT = "15s";

// Both Postgres drivers katasync uses (pg, PGlite) answer execute with rows.
type Rows = { rows: Record<string, unknown>[] };

// Sign-in bookkeeping: hashes, public keys, and live session ids. Hidden from
// describe_schema and refused by name in queries.
const AUTH_TABLES = [
	"sessions",
	"passkeys",
	"api_tokens",
	"setup_links",
	"auth_challenges",
];

// Functions that change the session, reach outside the database, or signal
// other connections (the app's own role may end its own backends).
const FORBIDDEN_FUNCTIONS = [
	"set_config",
	"pg_terminate_backend",
	"pg_cancel_backend",
	"pg_reload_conf",
	"dblink\\w*",
	"pg_read_\\w+",
	"pg_ls_\\w+",
	"pg_stat_file",
	"lo_(import|export|get|open|put|from_bytea)",
];

const REFUSED = new RegExp(
	`\\b(${[...AUTH_TABLES, ...FORBIDDEN_FUNCTIONS].join("|")})\\b`,
	"i",
);

export async function readOnlyQuery(
	text: string,
	limit = 200,
	connect = withOwnConnection,
) {
	const statement = text.trim().replace(/;\s*$/, "");
	if (statement === "") throw new QueryError("Give a SELECT to run");
	if (!(Number.isInteger(limit) && limit >= 1 && limit <= MAX_ROWS))
		throw new QueryError(`limit is 1 to ${MAX_ROWS}`);
	const refused = REFUSED.exec(statement)?.[1];
	if (refused)
		throw new QueryError(`${refused} isn't available to the query tool`);
	return connect((db) =>
		db.transaction(async (tx) => {
			await tx.execute(sql`set transaction read only`);
			await tx.execute(sql.raw(`set local statement_timeout = '${TIMEOUT}'`));
			// The newline ends a trailing -- comment before the wrapper.
			const result = (await tx.execute(
				sql`select * from (${sql.raw(statement)}\n) as q limit ${limit + 1}`,
			)) as unknown as Rows;
			const rows = result.rows.slice(0, limit).map(plain);
			return { rows, truncated: result.rows.length > limit };
		}),
	);
}

// JSON-friendly values: dates as ISO strings, big integers as numbers.
function plain(row: Record<string, unknown>) {
	return Object.fromEntries(
		Object.entries(row).map(([k, v]) => [
			k,
			v instanceof Date
				? v.toISOString()
				: typeof v === "bigint"
					? Number(v)
					: v,
		]),
	);
}

// Every table and view a query can read, with its columns and types.
export async function describeSchema(db: Db) {
	const result = (await db.execute(sql`
		select c.table_name, t.table_type, c.column_name, c.data_type, c.is_nullable
		from information_schema.columns c
		join information_schema.tables t
			on t.table_schema = c.table_schema and t.table_name = c.table_name
		where c.table_schema = 'public'
		order by c.table_name, c.ordinal_position
	`)) as unknown as Rows;
	const tables = new Map<string, { kind: string; columns: string[] }>();
	for (const r of result.rows) {
		const name = String(r.table_name);
		let table = tables.get(name);
		if (!table) {
			table = { kind: r.table_type === "VIEW" ? "view" : "table", columns: [] };
			tables.set(name, table);
		}
		table.columns.push(
			`${r.column_name} ${r.data_type}${r.is_nullable === "YES" ? "" : " not null"}`,
		);
	}
	for (const hidden of AUTH_TABLES) tables.delete(hidden);
	return Object.fromEntries(tables);
}
