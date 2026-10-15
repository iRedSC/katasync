import { eq } from "drizzle-orm";
import { shippingLocation } from "#/channels/stores";
import type { Db } from "#/db/client";
import { locations, orders } from "#/db/schema";
import type { Address } from "./shippo";

// The ship-to and ship-from addresses for an order, or why a label can't be
// made yet.
export async function shipAddresses(
	db: Db,
	orderId: number,
): Promise<{ from: Address; to: Address }> {
	const [o] = await db.select().from(orders).where(eq(orders.id, orderId));
	if (!o) throw new Error(`No order ${orderId}`);
	if (!o.shipAddress1 || !o.shipCity || !o.shipPostalCode || !o.shipCountry) {
		throw new Error(`${o.name} has no full shipping address`);
	}
	const locationId = await shippingLocation(db);
	const [from] = locationId
		? await db.select().from(locations).where(eq(locations.id, locationId))
		: [];
	if (
		!from?.address1 ||
		!from.city ||
		!from.postalCode ||
		!from.country ||
		!from.email
	) {
		throw new Error(
			"The warehouse has no ship-from address or email yet; both come from Shopify (primary location and store contact email)",
		);
	}
	return {
		from: {
			name: from.shipFromName ?? from.name,
			street1: from.address1,
			street2: from.address2,
			city: from.city,
			state: from.region ?? "",
			zip: from.postalCode,
			country: from.country,
			phone: from.phone,
			email: from.email,
		},
		to: {
			name: o.customerName ?? "Customer",
			street1: o.shipAddress1,
			street2: o.shipAddress2,
			city: o.shipCity,
			state: o.shipRegion ?? "",
			zip: o.shipPostalCode,
			country: o.shipCountry,
			phone: o.shipPhone,
		},
	};
}
