import { randomBytes } from "node:crypto";
import { sql } from "drizzle-orm";
import { type Db, getDb, withOwnConnection } from "#/db/client";
import { mcpLogin } from "#/db/schema";

// Ad hoc SQL for the MCP query tool. Safe to hand to a model: it connects as
// katasync_mcp, a login that can't read the secret tables (Postgres enforces
// that, whatever the query text says), Postgres refuses writes in a read-only
// transaction, the statement is sent with a parameter so Postgres takes
// exactly one statement (a "; delete ..." can't ride along), a time limit
// stops runaway queries, and the connection is its own, so nothing it does to
// the session reaches the app's pool. The login and the connection are the
// boundary; the checks below only give clearer errors.

export class QueryError extends Error {
	name = "QueryError";
}

export const MAX_ROWS = 2000;
const TIMEOUT = "15s";

// Both Postgres drivers katasync uses (pg, PGlite) answer execute with rows.
type Rows = { rows: Record<string, unknown>[] };

// Sign-in bookkeeping (hashes, public keys, live session ids), the key QZ
// Tray print jobs are signed with, the query tool's own password, and links
// that upload damage photos or PO files.
// katasync_mcp has a grant on every other table and view and none on these
// (see drizzle/0027_mcp_role.sql); they're also hidden from describe_schema
// and refused by name in queries.
export const SECRET_TABLES = [
	"staff_owner_guard",
	"bank_payout_guards",
	"sessions",
	"passkeys",
	"oauth_clients",
	"oauth_grants",
	"oauth_codes",
	"oauth_tokens",
	"setup_links",
	"auth_challenges",
	"passkey_staff",
	"oauth_grant_staff",
	"setup_link_scopes",
	"auth_challenge_bindings",
	"mcp_login",
	"qz_certificate",
	"damage_photo_uploads",
	"po_file_uploads",
	// Each row's share_token is a public link to the file.
	"buyer_reply_files",
	// Buyers' email addresses.
	"order_buyer_contacts",
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
	`\\b(${[...SECRET_TABLES, ...FORBIDDEN_FUNCTIONS].join("|")})\\b`,
	"i",
);

export async function readOnlyQuery(
	text: string,
	limit = 200,
	connect: typeof withMcpConnection = withMcpConnection,
) {
	const statement = text.trim().replace(/;\s*$/, "");
	if (statement === "") throw new QueryError("Give a SELECT to run");
	if (!(Number.isInteger(limit) && limit >= 1 && limit <= MAX_ROWS))
		throw new QueryError(`limit is 1 to ${MAX_ROWS}`);
	const refused = REFUSED.exec(statement)?.[1];
	if (refused)
		throw new QueryError(`${refused} isn't available to the query tool`);
	return connect(async (db) => {
		try {
			return await db.transaction(async (tx) => {
				await tx.execute(sql`set transaction read only`);
				await tx.execute(sql.raw(`set local statement_timeout = '${TIMEOUT}'`));
				// The newline ends a trailing -- comment before the wrapper.
				const result = (await tx.execute(
					sql`select * from (${sql.raw(statement)}\n) as q limit ${limit + 1}`,
				)) as unknown as Rows;
				const rows = result.rows.slice(0, limit).map(plain);
				return { rows, truncated: result.rows.length > limit };
			});
		} catch (error) {
			throw await explain(db, error);
		}
	});
}

// Postgres's own words, not Drizzle's "Failed query: <the SQL>", which hides
// them. A missing table also lists the ones there are, so a guessed name gets
// corrected instead of guessed again.
async function explain(db: Db, error: unknown) {
	const pg = (
		error instanceof Error && error.cause instanceof Error ? error.cause : error
	) as { message?: string; code?: string };
	if (typeof pg?.message !== "string") return error;
	if (pg.code === "42P01") {
		const names = Object.keys(await describeSchema(db)).join(", ");
		return new QueryError(
			`${pg.message}. Tables and views: ${names}. describe_schema has their columns.`,
			{ cause: pg },
		);
	}
	if (pg.code === "42703")
		return new QueryError(
			`${pg.message}. describe_schema lists each table's columns.`,
			{ cause: pg },
		);
	return new QueryError(pg.message, { cause: pg });
}

export const MCP_ROLE = "katasync_mcp";

// Isolated connections the query tool may hold at once. Each one is on top of
// the app's pool, so parallel calls wait their turn rather than use up the
// database's connections, and a call that waits too long is told to retry.
const MAX_CONNECTIONS = 4;
const SLOT_WAIT_MS = 10_000;
const CONNECT_TIMEOUT_MS = 5_000;
let inUse = 0;
const waiting: (() => void)[] = [];

export async function withConnectionSlot<T>(run: () => Promise<T>): Promise<T> {
	await takeSlot();
	try {
		return await run();
	} finally {
		// The slot goes straight to the next caller in line, if there is one.
		const next = waiting.shift();
		if (next) next();
		else inUse--;
	}
}

async function takeSlot() {
	if (inUse < MAX_CONNECTIONS) {
		inUse++;
		return;
	}
	await new Promise<void>((resolve, reject) => {
		const admit = () => {
			clearTimeout(timer);
			resolve();
		};
		const timer = setTimeout(() => {
			waiting.splice(waiting.indexOf(admit), 1);
			reject(
				new QueryError("Too many queries are running. Try again in a moment."),
			);
		}, SLOT_WAIT_MS);
		waiting.push(admit);
	});
}

// A connection of its own, logged in as katasync_mcp, and checked to be.
export async function withMcpConnection<T>(
	use: (db: Db) => Promise<T>,
): Promise<T> {
	// getDb first: it says clearly when DATABASE_URL is missing.
	const password = await mcpPassword(getDb());
	const url = mcpConnectionString(process.env.DATABASE_URL ?? "", password);
	return withConnectionSlot(() =>
		withOwnConnection(
			async (db) => {
				const { rows } = (await db.execute(
					sql`select session_user as who`,
				)) as unknown as { rows: { who: string }[] };
				if (rows[0]?.who !== MCP_ROLE)
					throw new Error(
						`The query tool logged in as ${rows[0]?.who}, not ${MCP_ROLE}`,
					);
				return use(db);
			},
			url,
			{ connectTimeoutMs: CONNECT_TIMEOUT_MS },
		),
	);
}

// DATABASE_URL with katasync_mcp's login in place of the owner's. pg lets
// ?user= and ?password= override the ones before the @, so those go too.
export function mcpConnectionString(databaseUrl: string, password: string) {
	const url = new URL(databaseUrl);
	url.username = MCP_ROLE;
	url.password = password;
	url.searchParams.delete("user");
	url.searchParams.delete("password");
	return url.toString();
}

// The role's password, made and set the first time. Two first callers can't
// set different ones: the second waits on the first's insert, then reads it.
// Roles belong to the whole server, so two databases on one server would
// fight over it; on Neon each branch has its own.
export async function mcpPassword(db: Db) {
	const [kept] = await db.select().from(mcpLogin);
	if (kept) return kept.password;
	return db.transaction(async (tx) => {
		const [made] = await tx
			.insert(mcpLogin)
			.values({ password: randomBytes(32).toString("hex") })
			.onConflictDoNothing()
			.returning();
		if (!made) {
			const [other] = await tx.select().from(mcpLogin);
			return other.password;
		}
		// Hex, so safe to put in the statement.
		await tx.execute(
			sql.raw(`alter role ${MCP_ROLE} password '${made.password}'`),
		);
		return made.password;
	});
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
	for (const hidden of SECRET_TABLES) tables.delete(hidden);
	return Object.fromEntries(tables);
}
