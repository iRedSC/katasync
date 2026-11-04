import { sql } from "drizzle-orm";
import {
	dispatchOrders,
	orderCharges,
	orderLines,
	orders,
	shipments,
	stores,
} from "#/db/schema";
import type { PackBlock } from "./remaining";

// The order's payment status, counting a refund of every line and its
// shipping as REFUNDED. Amazon reports a refunded order as paid forever, and
// can leave a cancelled one unshipped, so the marketplace's own refunds are
// the only sign. Read this, not orders.financial_status, wherever refunded
// matters. The outer table is named, since in a one-table select Drizzle
// leaves it off and a subquery would compare its own columns.
export const financialStatus = sql<string | null>`(case
	when (
		select sum(${orderCharges.amount}) from ${orderCharges}
		where ${orderCharges.orderId} = "orders"."id" and ${orderCharges.kind} = 'refund'
			and ${orderCharges.billedBy} = coalesce(
				nullif(split_part("orders"."marketplace_order_id", ':', 1), '')::"channel",
				(select ${stores.channel} from ${stores} where ${stores.id} = "orders"."store_id")
			)
	) >= (
		select nullif(sum(${orderLines.unitPrice} * ${orderLines.quantity}), 0)
		from ${orderLines} where ${orderLines.orderId} = "orders"."id"
	) + "orders"."shipping_charged"
	then 'REFUNDED'
	else "orders"."financial_status"
end)`;

// The one definition of "someone still has to ship this": not cancelled, not
// refunded or voided, not fully fulfilled, and not waiting on payment.
// Shopify's own "unfulfilled" filter also counts cancelled and refunded
// orders, so it can't be used as-is.
export const needsShipping = sql<boolean>`(
	${orders.cancelledAt} is null
	and ${orders.fulfillmentStatus} not in ('FULFILLED', 'FULFILLMENT_NOT_REQUIRED', 'RESTOCKED', 'AWAITING_PAYMENT')
	and coalesce(${financialStatus}, '') not in ('REFUNDED', 'VOIDED')
)`;

// Still to ship, from our own shelf: everything that gets a pin, a label,
// and a printed invoice. A drop-ship still needs shipping, by its supplier,
// so it stays on To ship but is never packed here.
export const needsPacking = sql<boolean>`(${needsShipping} and ${orders.dropShipAt} is null)`;

// What katasync itself holds of an order line, from its dispatches: what
// the marketplace's shipped count must reach to cover katasync's handoffs,
// and units in live dispatches not handed off yet. For a select from
// order_lines; remaining.ts turns them into what's packable, and
// drizzle/0182 defines both functions, which its triggers use too.
export const unitsShippedNeeded = sql<number>`order_line_shipped_needed(${orderLines.orderId}, ${orderLines.externalId})`;
export const unitsUnsent = sql<number>`order_line_unsent(${orderLines.orderId}, ${orderLines.externalId})`;

// A line whose marketplace count doesn't cover what katasync handed off:
// a snapshot from before that handoff, so the next sync will correct it.
const behindLine = sql`l.shipped_quantity < order_line_shipped_needed(l.order_id, l.external_id)`;

// Why an order's packable units aren't known, or null when they are
// (remaining.ts's PackBlock). Behind clears on the next sync. Short is behind even though the order
// synced after katasync's latest handoff (both clocks are ours), so it's
// likely not lag but a fulfillment taken back on the marketplace.
export const packBlock = sql<PackBlock | null>`(case
	when exists (
		select 1 from ${orderLines} l
		where l.order_id = "orders"."id" and l.quantity > 0 and l.shipped_quantity is null
	) then 'unknown'
	when exists (
		select 1 from ${orderLines} l
		where l.order_id = "orders"."id" and l.quantity > 0 and ${behindLine}
	) then case
		when "orders"."synced_at" > (
			select max(d.channel_sent_at) from ${dispatchOrders} d
			where d.order_id = "orders"."id" and d.reversed_at is null
		) then 'short'
		else 'behind'
	end
end)`;

// What's packable isn't known: a line with units and no shipped count,
// whatever the order's status (katasync rewrites that one locally, on a
// void), or a count still behind katasync's own handoffs. Such an order
// can't be packed (whyNotTogether), and the sync reads it again
// (unknown-shipped.ts); remaining.ts is the same rule.
export const remainingUnknown = sql<boolean>`(${packBlock} is not null)`;

// Waiting on a supplier's tracking: on To ship, but only for typing it in.
export const awaitsDropShip = sql<boolean>`(${needsShipping} and ${orders.dropShipAt} is not null)`;

// Cancelled or refunded after its label was bought but before tracking went
// out: the box must not ship, and the label should be voided to get the
// postage back. Test labels cost nothing, so they don't count.
export const labelToVoid = sql<boolean>`(
	(${orders.cancelledAt} is not null or coalesce(${financialStatus}, '') in ('REFUNDED', 'VOIDED'))
	and exists (
		select 1 from ${dispatchOrders} d
		join ${shipments} s on s.dispatch_id = d.dispatch_id
		where d.order_id = "orders"."id"
			and d.channel_sent_at is null
			and s.voided_at is null
			and not s.test
	)
)`;
