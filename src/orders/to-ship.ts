import { sql } from "drizzle-orm";
import { orders, shipments } from "#/db/schema";

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
export const labelToVoid = sql<boolean>`(
	(${orders.cancelledAt} is not null or coalesce(${orders.financialStatus}, '') in ('REFUNDED', 'VOIDED'))
	and exists (
		select 1 from ${shipments}
		where ${shipments.orderId} = ${orders.id}
			and ${shipments.voidedAt} is null
			and ${shipments.channelSentAt} is null
			and not ${shipments.test}
	)
)`;
