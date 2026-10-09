import { sql } from "drizzle-orm";
import { orders } from "#/db/schema";

// The one definition of "someone still has to ship this": not cancelled, not
// refunded or voided, and not fully fulfilled. Shopify's own "unfulfilled"
// filter also counts cancelled and refunded orders, so it can't be used as-is.
export const needsShipping = sql<boolean>`(
	${orders.cancelledAt} is null
	and ${orders.fulfillmentStatus} not in ('FULFILLED', 'FULFILLMENT_NOT_REQUIRED', 'RESTOCKED')
	and coalesce(${orders.financialStatus}, '') not in ('REFUNDED', 'VOIDED')
)`;
