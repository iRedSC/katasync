import { type SQL, sql } from "drizzle-orm";
import type { Db } from "#/db/client";
import { undoBatch } from "./ledger";
import { LedgerError } from "./ledger/post";

// Who a ledger batch belongs to. A batch posted by a workflow that keeps its
// own record (a PO receipt, a dispatch's reservations, a return) can only be
// undone through that workflow, or its record would say one thing while
// stock says another. Only batches nobody owns, such as counts and kit
// conversions, can be undone on their own. An undo belongs to whoever owns
// the batch it undid.
export type BatchOwner =
	| { kind: "purchaseOrder"; id: number }
	| { kind: "transfer"; id: number }
	| { kind: "fulfillment"; orderId: number; orderName: string }
	| { kind: "return"; orderId: number; orderName: string }
	| { kind: "sale"; orderId: number; orderName: string }
	| { kind: "repair"; id: number };

const owners = (batchId: SQL) => sql`
	select 'purchaseOrder' as kind, l.purchase_order_id as id, null as name
	from purchase_order_receipts r join purchase_order_lines l on l.id = r.line_id
	where r.batch_id = ${batchId}
	union all
	select 'purchaseOrder', l.purchase_order_id, null
	from purchase_order_damages d join purchase_order_lines l on l.id = d.line_id
	where d.batch_id = ${batchId}
	union all
	select 'transfer', t.id, null from transfers t where t.batch_id = ${batchId}
	union all
	select 'transfer', d.transfer_id, null
	from transfer_dispatches d where d.batch_id = ${batchId}
	union all
	select 'transfer', d.transfer_id, null
	from transfer_receipts r join transfer_dispatches d on d.id = r.dispatch_id
	where r.batch_id = ${batchId}
	union all
	select 'fulfillment', o.id, o.name
	from stock_commitment_entries e
	join stock_commitments c on c.id = e.commitment_id
	join orders o on o.id = c.order_id
	where e.batch_id = ${batchId}
	union all
	select 'return', o.id, o.name
	from order_returns r
	join order_lines l on l.id = r.order_line_id
	join orders o on o.id = l.order_id
	where r.batch_id = ${batchId}
	union all
	select 'sale', o.id, o.name
	from order_lines l join orders o on o.id = l.order_id
	where l.sale_batch_id = ${batchId}
	union all
	select 'sale', o.id, o.name
	from stock_commitments c join orders o on o.id = c.order_id
	where c.legacy_sale_batch_id = ${batchId}
	union all
	select 'repair', r.id, null from repairs r where r.parts_batch_id = ${batchId}`;

export async function batchOwner(
	db: Db,
	batchId: string,
): Promise<BatchOwner | null> {
	// An undo's batch carries the batch it undid as its reference.
	const { rows } = (await db.execute(sql`
		with candidates as (
			select ${batchId}::uuid as batch_id, 0 as depth
			union all
			select substring(m.reference from 6)::uuid, 1
			from movements m
			where m.batch_id = ${batchId}::uuid
				and m.reference ~ '^undo:[0-9a-f-]{36}$'
		)
		select o.kind, o.id, o.name
		from candidates undone
		cross join lateral (${owners(sql`undone.batch_id`)}) o
		order by undone.depth
		limit 1`)) as unknown as {
		rows: { kind: BatchOwner["kind"]; id: number; name: string | null }[];
	};
	const row = rows[0];
	if (!row) return null;
	switch (row.kind) {
		case "purchaseOrder":
		case "transfer":
		case "repair":
			return { kind: row.kind, id: Number(row.id) };
		case "fulfillment":
		case "return":
		case "sale":
			return {
				kind: row.kind,
				orderId: Number(row.id),
				orderName: row.name ?? "",
			};
	}
}

export function ownerUndoMessage(owner: BatchOwner) {
	switch (owner.kind) {
		case "purchaseOrder":
			return `This came in on PO ${owner.id}. Undo it on the PO.`;
		case "transfer":
			return `This was transfer T${owner.id}. Undo it on the transfer.`;
		case "fulfillment":
			return `This shipped on ${owner.orderName}. Void that dispatch so its reservations come back with the stock.`;
		case "return":
			return `This came back on ${owner.orderName}. Undo the return on the order.`;
		case "sale":
			return `This was sold on ${owner.orderName}. It comes back when the order is cancelled or returned.`;
		case "repair":
			return `These parts went to repair ${owner.id}. Change its parts there.`;
	}
}

// The only way to undo a batch by hand: refuses any batch a workflow owns.
export async function undoUnownedBatch(db: Db, batchId: string) {
	return db.transaction(async (tx) => {
		const owner = await batchOwner(tx, batchId);
		if (owner !== null) throw new LedgerError(ownerUndoMessage(owner));
		return undoBatch(tx, batchId);
	});
}
