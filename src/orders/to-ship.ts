import { sql } from "drizzle-orm";
import {
	dispatchOrders,
	orderCharges,
	orderLines,
	orders,
	shipments,
	stores,
} from "#/db/schema";

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
