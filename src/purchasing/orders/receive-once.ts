import { eq, sql } from "drizzle-orm";
import type { Db } from "#/db/client";
import { purchaseReceiveRequests } from "#/db/schema";
import { PurchaseOrderError } from "./lock";

type Kind = (typeof purchaseReceiveRequests.$inferInsert)["kind"];

// Runs a receiving request once per key. The sender makes the key when the
// request is made and sends it again with any retry: a key already used
// answers what it did then, whatever has changed since (the PO closed, the
// receipt was undone), and receives nothing more. The same key with a
// different request is refused, since that's a mistake, not a retry.
// `request` is compared as JSON, so it lists every field, unset ones as null.
// Same-key requests wait for each other, before any PO lock.
export async function receiveOnce<Result>(
	db: Db,
	input: { key: string; kind: Kind; request: Record<string, unknown> },
	run: (tx: Db) => Promise<Result>,
): Promise<Result> {
	const key = input.key.trim();
	if (key.length === 0) throw new PurchaseOrderError("A receipt needs a key");
	return db.transaction(async (tx) => {
		await tx.execute(
			sql`select pg_advisory_xact_lock(hashtext('purchase-receive'), hashtext(${key}))`,
		);
		const [earlier] = await tx
			.select({
				same: sql<boolean>`${purchaseReceiveRequests.kind} = ${input.kind} and ${purchaseReceiveRequests.request} = ${JSON.stringify(input.request)}::jsonb`,
				result: purchaseReceiveRequests.result,
			})
			.from(purchaseReceiveRequests)
			.where(eq(purchaseReceiveRequests.key, key));
		if (earlier) {
			if (!earlier.same)
				throw new PurchaseOrderError(
					`Receipt ${key} was recorded for something else`,
				);
			return earlier.result as Result;
		}
		const result = await run(tx);
		await tx.insert(purchaseReceiveRequests).values({
			key,
			kind: input.kind,
			request: input.request,
			result,
		});
		return result;
	});
}
