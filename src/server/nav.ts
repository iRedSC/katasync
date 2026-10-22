import { createServerFn } from "@tanstack/react-start";
import { countWaiting } from "#/buyers/threads";
import { countUnmatched } from "#/channels/unmatched";
import { getDb } from "#/db/client";
import { diagnosticsAttention } from "#/diagnostics/overview";
import { countImportant } from "#/inbox/market-mail";
import { countCountsDue } from "#/inventory/counts-due";
import { countAtRisk } from "#/markets/refresh";
import { countReturnsDue } from "#/orders/return-rates";
import { countOrdersToShip } from "#/server/orders";
import { countEmailsToFile, countPosReady } from "#/server/purchasing";

// The work waiting behind each sidebar item, so staff see it without opening
// the page.
export const getNavCounts = createServerFn({ method: "GET" }).handler(
	async () => {
		const db = getDb();
		const [
			toShip,
			returnsDue,
			posReady,
			emailsToFile,
			importantMail,
			due,
			unmatched,
			attention,
			atRisk,
			buyers,
		] = await Promise.all([
			countOrdersToShip(),
			countReturnsDue(db),
			countPosReady(),
			countEmailsToFile(),
			countImportant(db),
			countCountsDue(db),
			countUnmatched(db),
			diagnosticsAttention(db),
			countAtRisk(db),
			countWaiting(db, null),
		]);
		return {
			toShip,
			returnsDue,
			posReady,
			// Buyers waiting on a reply, important marketplace notices, and
			// supplier emails to file.
			inbox: buyers + importantMail.important + emailsToFile,
			// Critical among them, which turn the inbox's count red: every
			// buyer waiting is, since the marketplace's clock is running.
			criticalMail: buyers + importantMail.critical,
			countsDue: due,
			unmatched,
			attention,
			atRisk,
		};
	},
);

export type NavCounts = Awaited<ReturnType<typeof getNavCounts>>;
