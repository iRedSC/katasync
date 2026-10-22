import { createServerFn } from "@tanstack/react-start";
import { type } from "arktype";
import { getDb } from "#/db/client";
import {
	countAttention,
	marketEmailHtml,
	marketMailPage,
	readMarketMail,
	relabel,
	setDone,
} from "#/inbox/market-mail";
import { countUnfiled, emailHtml } from "#/purchasing/inbox/ingest";

// The marketplaces side of the Inbox page. Only server functions here: a
// plain export would keep these imports in the browser bundle.

const market = "'shopify' | 'amazon' | 'ebay' | 'tiktok'";
const label = "'attention' | 'orders' | 'returns' | 'updates'";

export const listMarketMail = createServerFn({ method: "GET" })
	.validator(type({ view: `${label} | 'done'`, market: `${market} | null` }))
	.handler(async ({ data }) => marketMailPage(getDb(), data.view, data.market));

export const setMarketEmailDone = createServerFn({ method: "POST" })
	.validator(type({ id: "number.integer > 0", done: "boolean" }))
	.handler(async ({ data }) => setDone(getDb(), data.id, data.done));

export const relabelMarketEmail = createServerFn({ method: "POST" })
	.validator(type({ id: "number.integer > 0", label }))
	.handler(async ({ data }) => relabel(getDb(), data.id, data.label));

// Reads the mailbox now, as the sweep does, so staff needn't wait for it.
export const checkMarketMailNow = createServerFn({ method: "POST" }).handler(
	async () => readMarketMail({ since: new Date(), sweep: true, db: getDb }),
);

// What waits in each mailbox, for the tabs: marketplace emails needing
// attention, supplier emails to file.
export const inboxCounts = createServerFn({ method: "GET" }).handler(
	async () => {
		const db = getDb();
		const [attention, unfiled] = await Promise.all([
			countAttention(db),
			countUnfiled(db),
		]);
		return { attention, toFile: unfiled.toFile };
	},
);

// An email as sent, fetched when it's opened rather than with the list.
// Null when katasync has only its text.
export const getEmailHtml = createServerFn({ method: "GET" })
	.validator(
		type({ box: "'purchasing' | 'marketplaces'", id: "number.integer > 0" }),
	)
	.handler(async ({ data }) =>
		data.box === "purchasing"
			? emailHtml(getDb(), data.id)
			: marketEmailHtml(getDb(), data.id),
	);
