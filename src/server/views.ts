import { createServerFn } from "@tanstack/react-start";
import { type } from "arktype";
import { asc } from "drizzle-orm";
import { getDb } from "#/db/client";
import { productViews } from "#/db/schema";
import {
	deleteView as removeView,
	saveView as storeView,
} from "#/products/saved-views";
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
	.handler(async ({ data }) => storeView(getDb(), data));

export const deleteView = createServerFn({ method: "POST" })
	.validator(type({ id: "number.integer > 0" }))
	.handler(async ({ data }) => removeView(getDb(), data.id));
