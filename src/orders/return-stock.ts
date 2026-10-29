import { sql } from "drizzle-orm";
import { orderLines } from "#/db/schema";

export const committedStock = sql<boolean>`exists (select 1 from quantity_mode where mode = 'committed')`;

// A line that took stock, or (as order_line_costs counts it) sold before its
// store's cutover, shipped all of it; with committed stock, otherwise, what
// its handoffs shipped.
export const returnQuantity = sql<number>`case
	when not ${committedStock} or ${orderLines.saleBatchId} is not null then ${orderLines.quantity}
	when ${orderLines.productId} is not null and exists (select 1 from orders o
		join stores st on st.id = o.store_id
		where o.id = "order_lines"."order_id" and o.placed_at < st.stock_from) then ${orderLines.quantity}
	else coalesce((select sum(e.quantity) from stock_commitment_entries e
		join stock_commitments c on c.id = e.commitment_id
		where c.order_line_id = "order_lines"."id" and e.kind = 'consume'
		and not exists (select 1 from stock_commitment_entries r where r.restores_entry_id = e.id)), 0)::int
end`;
