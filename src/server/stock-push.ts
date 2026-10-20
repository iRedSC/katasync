import { createServerFn } from "@tanstack/react-start";
import { type } from "arktype";
import { eq, sql } from "drizzle-orm";
import { getDb } from "#/db/client";
import { listings, stores } from "#/db/schema";
import { pushMode, stockBlocker } from "#/stock-push/push";
import { setStorePush } from "#/stock-push/switch";

// Each store's stock push, for Settings: whether it's on, how its last pass
// went, and how many of its mapped listings katasync can set.
export const listStockPush = createServerFn({ method: "GET" }).handler(
	async () => {
		const db = getDb();
		const counts = db
			.select({
				storeId: listings.storeId,
				listed: sql<number>`count(*)::int`.as("listed"),
				mapped:
					sql<number>`count(*) filter (where ${listings.productId} is not null and ${listings.fulfillment} = 'merchant')::int`.as(
						"mapped",
					),
				ready:
					sql<number>`count(*) filter (where ${listings.productId} is not null and ${listings.fulfillment} = 'merchant' and ${listings.stockPush}->>'state' = 'ready')::int`.as(
						"ready",
					),
				failing:
					sql<number>`count(*) filter (where ${listings.productId} is not null and ${listings.fulfillment} = 'merchant' and ${listings.stockPush}->>'error' is not null)::int`.as(
						"failing",
					),
			})
			.from(listings)
			.groupBy(listings.storeId)
			.as("counts");
		const rows = await db
			.select({
				id: stores.id,
				name: stores.name,
				channel: stores.channel,
				on: stores.pushStock,
				readAt: stores.stockReadAt,
				pushedAt: stores.stockPushedAt,
				error: stores.stockPushError,
				listed: sql<number>`coalesce(${counts.listed}, 0)`,
				mapped: sql<number>`coalesce(${counts.mapped}, 0)`,
				ready: sql<number>`coalesce(${counts.ready}, 0)`,
				failing: sql<number>`coalesce(${counts.failing}, 0)`,
			})
			.from(stores)
			.leftJoin(counts, eq(counts.storeId, stores.id))
			.orderBy(stores.name);
		return {
			stores: rows,
			// Off production a pass only works out what it would set.
			writes: pushMode() === "write",
			blocker: await stockBlocker(db),
		};
	},
);

// Turns a store's stock push on or off. Turning it on starts from a fresh
// read of the channel, so the first pass writes only what really differs.
export const setStockPush = createServerFn({ method: "POST" })
	.validator(type({ id: "number.integer > 0", on: "boolean" }))
	.handler(async ({ data }) => setStorePush(getDb(), data.id, data.on));
