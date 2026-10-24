import { sql } from "drizzle-orm";
import { orderLines } from "#/db/schema";

export type FromStore =
	| { sku: string; location: string; quantity: number }[]
	| null;

// What of a shipped line's sale came off the retail store's shelf because
// the warehouse was out (see recordSale), so someone fetches it from the
// store before it ships. A tool set lists its parts. Empty for in-store
// sales, and once the sale is undone (a cancelled order).
export const fromStore = sql<FromStore>`case when
	exists (select 1 from stock_commitments c where c.order_line_id = "order_lines"."id")
	and not exists (
		select 1 from stock_commitment_entries e join stock_commitments c on c.id = e.commitment_id
		where c.order_line_id = "order_lines"."id" and e.kind = 'consume'
		and not exists (select 1 from stock_commitment_entries r where r.restores_entry_id = e.id)
	) then null else coalesce((
	select json_agg(json_build_object('sku', p.sku, 'location', l.name, 'quantity', -m.delta) order by p.sku)
	from movements m
	join locations l on l.id = m.location_id
	join products p on p.id = m.product_id
	where (m.batch_id = ${orderLines.saleBatchId} or exists (
		select 1 from stock_commitment_entries e join stock_commitments c on c.id = e.commitment_id
		where c.order_line_id = "order_lines"."id" and e.batch_id = m.batch_id and e.kind = 'consume'
		and not exists (select 1 from stock_commitment_entries r where r.restores_entry_id = e.id)
	))
		and l.kind = 'retail'
		and m.reason = 'sale'
		and not exists (select 1 from orders o where o.id = ${orderLines.orderId} and o.sold_in_store)
		and not exists (select 1 from movements u where u.reference = 'undo:' || m.batch_id::text)
), '[]'::json) end`;
