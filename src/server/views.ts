import { createServerFn } from "@tanstack/react-start";
import { type } from "arktype";
import { asc, eq, sql } from "drizzle-orm";
import { getDb } from "#/db/client";
import { productViews } from "#/db/schema";
import type { Filter } from "#/products/search";
import {
	filtersType,
	parseProductSort,
	sortType,
	spellProductSort,
	type View,
} from "#/products/views";

export const listViews = createServerFn({ method: "GET" }).handler(
	async (): Promise<View[]> => {
		const rows = await getDb()
			.select()
			.from(productViews)
			.orderBy(asc(productViews.position), asc(productViews.id));
		return rows.map((r) => ({
			id: r.id,
			name: r.name,
			filters: r.filters as Filter[],
			// Cleaned, so an old spelling or a dropped column reads as today's.
			sort: spellProductSort(parseProductSort(r.sort)),
		}));
	},
);

// Creates a view, or updates one when id is given. New views go last.
export const saveView = createServerFn({ method: "POST" })
	.validator(
		type({
			"id?": "number.integer > 0",
			name: "string.trim",
			filters: filtersType,
			sort: sortType,
		}),
	)
	.handler(async ({ data }) => {
		const db = getDb();
		const name = data.name.trim();
		if (name === "") throw new Error("Give the view a name");
		const [taken] = await db
			.select({ id: productViews.id })
			.from(productViews)
			.where(eq(productViews.name, name));
		if (taken && taken.id !== data.id) {
			throw new Error(`There's already a view called “${name}”`);
		}
		if (data.id) {
			await db
				.update(productViews)
				.set({ name, filters: data.filters, sort: data.sort })
				.where(eq(productViews.id, data.id));
			return { id: data.id };
		}
		const [row] = await db
			.insert(productViews)
			.values({
				name,
				filters: data.filters,
				sort: data.sort,
				position: sql`(select coalesce(max(${productViews.position}), 0) + 1 from ${productViews})`,
			})
			.returning({ id: productViews.id });
		return { id: row.id };
	});

export const deleteView = createServerFn({ method: "POST" })
	.validator(type({ id: "number.integer > 0" }))
	.handler(async ({ data }) => {
		await getDb().delete(productViews).where(eq(productViews.id, data.id));
	});
