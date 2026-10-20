import { getDb } from "#/db/client";
import { locations } from "#/db/schema";
import { isOurs } from "#/inventory/locations";

// Where online stock comes from: the warehouse, and the retail store for
// what the warehouse is out of.
export async function sellableLocationIds() {
	const rows = await getDb()
		.select({ id: locations.id })
		.from(locations)
		.where(isOurs);
	return rows.map((r) => r.id);
}
