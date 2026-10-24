import type { Db } from "#/db/client";
import { type channel, marketEmails } from "#/db/schema";
import { formatMoney } from "#/lib/format";
import { amazonOrderLink } from "#/orders/fulfillment";
import { flagsOf } from "./rules";

// A carrier re-billing a label by more than LARGE_REBILL puts a critical
// item in the marketplaces inbox, written by katasync rather than read from
// the mailbox, so it's worked through (read, done) like any notice. It names
// the order, so the inbox shows the order above it, and links to Fix
// postage, where the re-bill is grouped with others like it. Server only.

// Dollars. A re-bill this size or under raises nothing.
export const LARGE_REBILL = 10;

export const KATASYNC_SENDER = "alerts@katasync";

type Channel = (typeof channel.enumValues)[number];

export type Rebill = {
	// One item per key, ever: the same re-bill read again raises nothing.
	key: `order:${number}:${Channel}` | `shipment:${number}`;
	orderId: number;
	orderName: string;
	// Who sold it, whose inbox it shows under.
	market: Channel;
	// The marketplace's own order ID, to open it there.
	marketplaceId: string | null;
	// What was re-billed in all, and what the label cost to begin with.
	amount: number;
	label: number;
};

// Whether a re-bill going from `before` to `after` just became large: so a
// report read again, or a second small re-bill on a large one, raises
// nothing new.
export const crossesLarge = (before: number, after: number) =>
	before <= LARGE_REBILL && after > LARGE_REBILL;

const escapeHtml = (s: string) =>
	s.replace(
		/[&<>"]/g,
		(c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c] ?? c,
	);

export async function alertRebill(db: Db, r: Rebill, now = new Date()) {
	const amount = formatMoney(r.amount);
	const label = formatMoney(r.label);
	const times = r.label > 0 ? Math.round((r.amount / r.label) * 10) / 10 : null;
	const sellerCentral =
		r.market === "amazon" && r.marketplaceId
			? amazonOrderLink(r.marketplaceId)
			: null;
	const summary = `Re-billed ${amount} on a ${label} label${times ? ` (${times}× the label)` : ""}.`;
	const links: [string, string][] = [
		["Fix postage", "/profit/postage"],
		["Order in katasync", `/orders/${r.orderId}`],
	];
	if (sellerCentral)
		links.push(["Package as declared, in Seller Central", sellerCentral]);
	await db
		.insert(marketEmails)
		.values({
			messageId: `katasync:rebill:${r.key}`,
			market: r.market,
			folder: "orders",
			...flagsOf("critical"),
			// Set by katasync, so the rules leave its folder and level alone.
			relabelledAt: now,
			importanceSetAt: now,
			fromAddress: KATASYNC_SENDER,
			fromName: "katasync",
			recipients: [],
			subject: `Postage re-billed ${amount}: ${r.orderName}`,
			body: [
				`${r.orderName}`,
				summary,
				...links.map(([text, href]) => `${text}: ${href}`),
			].join("\n"),
			bodyHtml: `<p><b>${escapeHtml(r.orderName)}</b></p><p>${escapeHtml(summary)}</p><p>${links
				.map(
					([text, href]) =>
						`<a href="${escapeHtml(href)}">${escapeHtml(text)}</a>`,
				)
				.join(" · ")}</p>`,
			receivedAt: now,
		})
		.onConflictDoNothing();
}
