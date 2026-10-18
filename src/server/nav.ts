import { createServerFn } from "@tanstack/react-start";
import { countUnmatched } from "#/channels/unmatched";
import { getDb } from "#/db/client";
import { diagnosticsAttention } from "#/diagnostics/overview";
import { countCountsDue } from "#/server/catalog";
import { countOrdersToShip } from "#/server/orders";
import { countPosReady } from "#/server/purchasing";

// The work waiting behind each sidebar item, so staff see it without opening
// the page.
export const getNavCounts = createServerFn({ method: "GET" }).handler(
	async () => {
		const db = getDb();
		const [toShip, posReady, due, unmatched, attention] = await Promise.all([
			countOrdersToShip(),
			countPosReady(),
			countCountsDue(db),
			countUnmatched(db),
			diagnosticsAttention(db),
		]);
		return { toShip, posReady, countsDue: due, unmatched, attention };
	},
);

export type NavCounts = Awaited<ReturnType<typeof getNavCounts>>;
