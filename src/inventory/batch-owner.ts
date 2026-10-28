import { type SQL, sql } from "drizzle-orm";
import type { Db } from "#/db/client";
import { undoBatch } from "./ledger";
import { LedgerError } from "./ledger/post";

// Who a ledger batch belongs to. A batch posted by a workflow that keeps its
// own record (a PO receipt, a dispatch's reservations, a return) can only be
// undone through that workflow, or its record would say one thing while
// stock says another. Only batches nobody owns, such as counts and kit
// conversions, can be undone on their own. An undo belongs to whoever owns
// the batch it undid, through any chain of undos.
//
// A workflow's record can go away (undoing a return deletes it), so the
// reference its movements were posted with also names the owner. References
// never change, so ownership outlives the record.
export type BatchOwner =
	| { kind: "purchaseOrder"; id: number }
	| { kind: "transfer"; id: number }
	| { kind: "fulfillment"; orderId: number; orderName: string }
	| { kind: "return"; orderId: number; orderName: string }
	| { kind: "sale"; orderId: number; orderName: string }
	| { kind: "order"; orderId: number; orderName: string }
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

// The owner named by the batch's reference, as posted by poName, transfers,
// the bench, returns, and order stock.
const referenced = (batchId: SQL) => sql`
	select case
			when m.reference ~ '^PO [0-9]+$' then 'purchaseOrder'
			when m.reference ~ '^transfer:[0-9]+$' then 'transfer'
			when m.reference ~ '^bench:[0-9]+$' then 'repair'
			when m.reference ~ '^return:[0-9]+:[0-9]+$' then 'return'
			when m.reference ~ '^order:[0-9]+:[0-9]+$' then 'order'
		end as kind,
		substring(m.reference from '^[a-zA-Z]+[ :]([0-9]+)')::int as id,
		o.name
	from (
		select distinct reference from movements where batch_id = ${batchId}
	) m
	left join orders o
		on m.reference ~ '^(return|order):'
		and o.id = substring(m.reference from '^[a-z]+:([0-9]+)')::int
	where m.reference ~ '^(PO [0-9]+|(transfer|bench):[0-9]+|(return|order):[0-9]+:[0-9]+)$'`;

export async function batchOwner(
	db: Db,
	batchId: string,
): Promise<BatchOwner | null> {
	// An undo's batch carries the batch it undid as its reference.
	const { rows } = (await db.execute(sql`
		with recursive candidates as (
			select ${batchId}::uuid as batch_id, 0 as depth
			union
			select substring(m.reference from 6)::uuid, c.depth + 1
			from candidates c
			join movements m on m.batch_id = c.batch_id
			where m.reference ~ '^undo:[0-9a-f-]{36}$'
		)
		select o.kind, o.id, o.name
		from candidates undone
		cross join lateral (
			select *, 0 as rank from (${owners(sql`undone.batch_id`)}) recorded
			union all
			select *, 1 from (${referenced(sql`undone.batch_id`)}) named
		) o
		order by undone.depth, o.rank
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
		case "order":
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
			return `This is a return on ${owner.orderName}. Change it on the order.`;
		case "sale":
			return `This was sold on ${owner.orderName}. It comes back when the order is cancelled or returned.`;
		case "order":
			return `This was ${owner.orderName}'s stock. Change it on the order.`;
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
