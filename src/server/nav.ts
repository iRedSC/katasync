import { createServerFn } from "@tanstack/react-start";
import { countUnmatched } from "#/channels/unmatched";
import { getDb } from "#/db/client";
import { diagnosticsAttention } from "#/diagnostics/overview";
import { countReturnsDue } from "#/orders/return-rates";
import { countCountsDue } from "#/server/catalog";
import { countOrdersToShip } from "#/server/orders";
import { countPosReady } from "#/server/purchasing";

// The work waiting behind each sidebar item, so staff see it without opening
// the page.
export const getNavCounts = createServerFn({ method: "GET" }).handler(
	async () => {
		const db = getDb();
		const [toShip, returnsDue, posReady, due, unmatched, attention] =
			await Promise.all([
				countOrdersToShip(),
				countReturnsDue(db),
				countPosReady(),
				countCountsDue(db),
				countUnmatched(db),
				diagnosticsAttention(db),
			]);
		return {
			toShip,
			returnsDue,
			posReady,
			countsDue: due,
			unmatched,
			attention,
		};
	},
);

export type NavCounts = Awaited<ReturnType<typeof getNavCounts>>;
