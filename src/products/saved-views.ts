import { eq, sql } from "drizzle-orm";
import type { Db } from "#/db/client";
import { productViews } from "#/db/schema";
import type { Filter } from "#/products/search";
import type { SortText } from "#/products/views";

// Creates a saved product view, or updates one when id is given. New views go
// last. Names are unique.
export async function saveView(
	db: Db,
	input: { id?: number; name: string; filters: Filter[]; sort: SortText },
) {
	const name = input.name.trim();
	if (name === "") throw new Error("Give the view a name");
	const [taken] = await db
		.select({ id: productViews.id })
		.from(productViews)
		.where(eq(productViews.name, name));
	if (taken && taken.id !== input.id) {
		throw new Error(`There's already a view called “${name}”`);
	}
	if (input.id) {
		const updated = await db
			.update(productViews)
			.set({ name, filters: input.filters, sort: input.sort })
			.where(eq(productViews.id, input.id))
			.returning({ id: productViews.id });
		if (updated.length === 0) throw new Error(`No view ${input.id}`);
		return { id: input.id };
	}
	const [row] = await db
		.insert(productViews)
		.values({
			name,
			filters: input.filters,
			sort: input.sort,
			position: sql`(select coalesce(max(${productViews.position}), 0) + 1 from ${productViews})`,
		})
		.returning({ id: productViews.id });
	return { id: row.id };
}

export async function deleteView(db: Db, id: number) {
	await db.delete(productViews).where(eq(productViews.id, id));
}
