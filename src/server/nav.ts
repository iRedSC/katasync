import { createServerFn } from "@tanstack/react-start";
import { countUnmatched } from "#/channels/unmatched";
import { getDb } from "#/db/client";
import { diagnosticsAttention } from "#/diagnostics/overview";
import { countImportant } from "#/inbox/market-mail";
import { countAtRisk } from "#/markets/refresh";
import { countReturnsDue } from "#/orders/return-rates";
import { countCountsDue } from "#/server/catalog";
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
		]);
		return {
			toShip,
			returnsDue,
			posReady,
			// Important marketplace notices, and supplier emails to file.
			inbox: importantMail.important + emailsToFile,
			// Critical notices among them, which turn the inbox's count red.
			criticalMail: importantMail.critical,
			countsDue: due,
			unmatched,
			attention,
			atRisk,
		};
	},
);

export type NavCounts = Awaited<ReturnType<typeof getNavCounts>>;
