import { createServerFn } from "@tanstack/react-start";
import { type } from "arktype";
import { eq, sql } from "drizzle-orm";
import { getDb } from "#/db/client";
import { movements, products } from "#/db/schema";
import { undoBatch } from "#/inventory/ledger";
import { transferName, transferOfBatch } from "#/inventory/transfers";
import { purchaseOrderOfBatch } from "#/purchasing/orders";

// The ledger, one row per operation: an import or an assembly reads as one
// line instead of hundreds.
export const listMovementBatches = createServerFn({ method: "GET" }).handler(
	async () => {
		const rows = await getDb()
			.select({
				batchId: movements.batchId,
				createdAt: sql<Date>`min(${movements.createdAt})`,
				lines: sql<number>`count(*)::int`,
				delta: sql<number>`sum(${movements.delta})::int`,
				// node-postgres can't parse arrays of enums, so join to text.
				reasons: sql<string>`string_agg(distinct ${movements.reason}::text, ',')`,
				reference: sql<string | null>`max(${movements.reference})`,
				note: sql<string | null>`max(${movements.note})`,
				sku: sql<string>`min(${products.sku})`,
				name: sql<string>`min(${products.name})`,
				imageUrl: sql<string | null>`min(${products.imageUrl})`,
			})
			.from(movements)
			.innerJoin(products, eq(products.id, movements.productId))
			.groupBy(movements.batchId)
			.orderBy(sql`max(${movements.id}) desc`)
			.limit(100);
		return rows.map((r) => ({
			...r,
			reasons: r.reasons.split(","),
			createdAt: new Date(r.createdAt),
		}));
	},
);

export const undoMovement = createServerFn({ method: "POST" })
	.validator(type({ batchId: "string.uuid" }))
	.handler(async ({ data }) => {
		const db = getDb();
		// A PO receipt undone here would leave the PO thinking it arrived.
		const po = await purchaseOrderOfBatch(db, data.batchId);
		if (po !== null) throw new Error(`Undo this on PO ${po}.`);
		// Undone here, a transfer would still say it was sent.
		const transfer = await transferOfBatch(db, data.batchId);
		if (transfer !== null)
			throw new Error(`Undo this on transfer ${transferName(transfer)}.`);
		await undoBatch(db, data.batchId);
	});
