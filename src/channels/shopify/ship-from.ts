import { type } from "arktype";
import { eq } from "drizzle-orm";
import type { Db } from "#/db/client";
import { locations } from "#/db/schema";
import { shopifyQuery } from "./client";

const shipFromInfo = type({
	shop: { name: "string", contactEmail: "string | null" },
	locations: {
		nodes: type({
			isPrimary: "boolean",
			address: {
				address1: "string | null",
				address2: "string | null",
				city: "string | null",
				provinceCode: "string | null",
				zip: "string | null",
				countryCode: "string | null",
				phone: "string | null",
			},
		}).array(),
	},
});

// Labels ship from the shop's primary Shopify location. Its address is copied
// onto our one owned location, so nobody types it in (or forgets to update
// it). With several owned locations katasync can't tell which is which, so it
// leaves them alone.
export async function syncShipFrom(db: Db) {
	const owned = await db
		.select({ id: locations.id })
		.from(locations)
		.where(eq(locations.kind, "owned"));
	if (owned.length !== 1) return;
	const info = shipFromInfo.assert(
		await shopifyQuery(
			"{ shop { name contactEmail } locations(first: 20) { nodes { isPrimary address { address1 address2 city provinceCode zip countryCode phone } } } }",
			{},
		),
	);
	const primary = info.locations.nodes.find((l) => l.isPrimary);
	if (!primary) return;
	await db
		.update(locations)
		.set({
			shipFromName: info.shop.name,
			address1: primary.address.address1,
			address2: primary.address.address2,
			city: primary.address.city,
			region: primary.address.provinceCode,
			postalCode: primary.address.zip,
			country: primary.address.countryCode,
			phone: primary.address.phone,
			email: info.shop.contactEmail,
		})
		.where(eq(locations.id, owned[0].id));
}
