import { sql } from "drizzle-orm";
import { dispatchOrders, orders, shipments } from "#/db/schema";

// The one definition of "someone still has to ship this": not cancelled, not
// refunded or voided, not fully fulfilled, and not waiting on payment.
// Shopify's own "unfulfilled" filter also counts cancelled and refunded
// orders, so it can't be used as-is.
export const needsShipping = sql<boolean>`(
	${orders.cancelledAt} is null
	and ${orders.fulfillmentStatus} not in ('FULFILLED', 'FULFILLMENT_NOT_REQUIRED', 'RESTOCKED', 'AWAITING_PAYMENT')
	and coalesce(${orders.financialStatus}, '') not in ('REFUNDED', 'VOIDED')
)`;

// Cancelled or refunded after its label was bought but before tracking went
// out: the box must not ship, and the label should be voided to get the
// postage back. Test labels cost nothing, so they don't count.
// The outer table is named, since in a one-table select Drizzle leaves it
// off and the subquery would compare its own columns.
export const labelToVoid = sql<boolean>`(
	(${orders.cancelledAt} is not null or coalesce(${orders.financialStatus}, '') in ('REFUNDED', 'VOIDED'))
	and exists (
		select 1 from ${dispatchOrders} d
		join ${shipments} s on s.dispatch_id = d.dispatch_id
		where d.order_id = "orders"."id"
			and d.channel_sent_at is null
			and s.voided_at is null
			and not s.test
	)
)`;
