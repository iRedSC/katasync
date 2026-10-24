import { sql } from "drizzle-orm";

// Units of an order line on the bench: back from the customer, not yet
// received, each open bench job holding one (src/repairs/bench.ts). They
// can't be received again, and aren't due. Reads "order_lines"."id" from
// the outer query; `except` leaves out the job being listed, whose unit
// is the one now being received.
export const onBench = (except: number | null = null) =>
	sql<number>`(select count(*) from repairs b
		where b.return_line_id = "order_lines"."id"
		and b.status::text in ('received', 'waiting_parts', 'in_repair', 'ready')
		${except === null ? sql`` : sql`and b.id <> ${except}`})::int`;
