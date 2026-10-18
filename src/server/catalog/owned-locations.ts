import { eq } from "drizzle-orm";
import { getDb } from "#/db/client";
import { locations } from "#/db/schema";

export async function ownedLocationIds() {
	const rows = await getDb()
		.select({ id: locations.id })
		.from(locations)
		.where(eq(locations.kind, "owned"));
	return rows.map((r) => r.id);
}
