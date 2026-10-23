import { sql } from "drizzle-orm";
import type { Db } from "#/db/client";
import { type AuditContext, auditSetting, currentContext } from "./context";

// A Db that hands the current actor to the audit triggers
// (src/db/pending/identity.sql) as a transaction-local setting, so it ends
// with the transaction and never reaches the next user of the connection.
// Transactions set it first thing. A write outside one is run alone in a
// transaction of its own that sets it; reads go straight through.

export const AUDIT_SETTING = "katasync.actor";

type Prepared = Record<
	"execute" | "all" | "values",
	(...a: unknown[]) => unknown
>;
type QueryMetadata = { type?: string } | undefined;
type Session = {
	prepareQuery: (...args: unknown[]) => Prepared;
	transaction: (
		work: (tx: Db) => Promise<unknown>,
		config?: unknown,
	) => Promise<unknown>;
};
type Internals = { session: Session; _: Record<string, unknown> };

const READS = /^[\s(]*(select|show|explain|values|table)\b/i;
const RUNS = new Set(["execute", "all", "values"]);

export function isWrite(query: { sql: string }, metadata: QueryMetadata) {
	if (metadata?.type) return metadata.type !== "select";
	return !READS.test(query.sql);
}

export const stampActor = (tx: Db, context: AuditContext) =>
	tx.execute(
		sql`select set_config(${AUDIT_SETTING}, ${auditSetting(context)}, true)`,
	);

const sessionOf = (db: Db) => (db as unknown as Internals).session;

const marker = Symbol.for("katasync.audited");

export function audited(db: Db): Db {
	if ((db as unknown as { [marker]?: true })[marker]) return db;
	const inner = sessionOf(db);
	const transaction: Session["transaction"] = (work, config) => {
		const context = currentContext();
		return inner.transaction(async (tx) => {
			if (context) await stampActor(tx, context);
			return work(tx);
		}, config);
	};
	const alone =
		(args: unknown[], method: string, prepared: Prepared) =>
		(...runArgs: unknown[]) => {
			const context = currentContext();
			if (!context) return prepared[method as keyof Prepared](...runArgs);
			return inner.transaction(async (tx) => {
				await stampActor(tx, context);
				const again = sessionOf(tx).prepareQuery(...args);
				return again[method as keyof Prepared](...runArgs);
			});
		};
	const session: Session = new Proxy(inner, {
		get(target, key, receiver) {
			if (key === "transaction") return transaction;
			if (key === "prepareQuery")
				return (...args: unknown[]) => {
					const prepared = target.prepareQuery(...args);
					const [query, , , , , metadata] = args as [
						{ sql: string },
						...unknown[],
					];
					if (!isWrite(query, metadata as QueryMetadata)) return prepared;
					return new Proxy(prepared, {
						get(p, method, r) {
							return typeof method === "string" && RUNS.has(method)
								? alone(args, method, p)
								: Reflect.get(p, method, r);
						},
					});
				};
			return Reflect.get(target, key, receiver);
		},
	});
	const internals = db as unknown as Internals;
	return Object.create(db, {
		session: { value: session },
		_: { value: { ...internals._, session } },
		[marker]: { value: true },
	});
}
