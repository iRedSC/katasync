import { createServerFn } from "@tanstack/react-start";
import { type } from "arktype";
import { getDb } from "#/db/client";
import { marketAnalytics } from "#/markets/analytics";
import { attentionQueue } from "#/markets/queue";
import { checkable, checkStale, readStanding } from "#/markets/refresh";
import { resolveRange } from "#/orders/profit";
import { rangeType } from "#/server/profit";

// Markets: what each marketplace sells, and where the account stands.

export const getMarkets = createServerFn({ method: "GET" })
	.validator(type({ range: rangeType }))
	.handler(async ({ data }) => {
		const db = getDb();
		const range = await resolveRange(db, data.range);
		return { range, markets: await marketAnalytics(db, range) };
	});

export const getStanding = createServerFn({ method: "GET" }).handler(
	async () => {
		const db = getDb();
		const rows = await readStanding(db);
		return { rows, checkable, queue: await attentionQueue(db, rows) };
	},
);

// Checks markets whose standing is older than maxAgeMs; 0 checks them all.
// Returns which it checked.
export const refreshStanding = createServerFn({ method: "POST" })
	.validator(type({ "maxAgeMs?": "number >= 0" }))
	.handler(async ({ data }) => checkStale(getDb(), data.maxAgeMs));
