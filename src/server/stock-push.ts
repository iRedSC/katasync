import { createServerFn } from "@tanstack/react-start";
import { type } from "arktype";
import { and, eq, isNotNull, sql } from "drizzle-orm";
import { getDb } from "#/db/client";
import { listings, stores } from "#/db/schema";
import { pushMode, stockBlocker } from "#/stock-push/push";

// Each store's stock push, for Settings: whether it's on, how its last pass
// went, and how many of its mapped listings katasync can set.
export const listStockPush = createServerFn({ method: "GET" }).handler(
	async () => {
		const db = getDb();
		const counts = db
			.select({
				storeId: listings.storeId,
				mapped: sql<number>`count(*)::int`.as("mapped"),
				ready:
					sql<number>`count(*) filter (where ${listings.stockPush}->>'state' = 'ready')::int`.as(
						"ready",
					),
				failing:
					sql<number>`count(*) filter (where ${listings.stockPush}->>'error' is not null)::int`.as(
						"failing",
					),
			})
			.from(listings)
			.where(
				and(
					isNotNull(listings.productId),
					eq(listings.fulfillment, "merchant"),
				),
			)
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
	.handler(async ({ data }) => {
		const db = getDb();
		if (data.on) {
			const blocker = await stockBlocker(db);
			if (blocker) throw new Error(blocker);
		}
		const [store] = await db
			.update(stores)
			.set(
				data.on
					? { pushStock: true, stockReadAt: null, stockPushError: null }
					: { pushStock: false },
			)
			.where(eq(stores.id, data.id))
			.returning({ name: stores.name });
		if (!store) throw new Error(`Unknown store ${data.id}`);
		return store;
	});
