import { and, desc, eq, gte, sql } from "drizzle-orm";
import type { Db } from "#/db/client";
import { purchaseOrders, suppliers } from "#/db/schema";
import { inboxAddress } from "./graph";
import { unfiledEmails } from "./ingest";

// Kept out of src/server/purchasing/inbox.ts: a server-function file that
// exports a plain function keeps its imports in the browser bundle, and
// those reach the stock ledger's node:crypto, which stops every page from
// starting.

// Emails waiting to be filed, with the POs they could go on: sent in the last
// half year, the sender's supplier's first. None until the inbox is set up.
export async function unfiledForList(db: Db) {
	const connected = inboxAddress() !== null;
	const [emails, pos] = await Promise.all([
		connected ? unfiledEmails(db, { limit: 50 }) : [],
		db
			.select({
				id: purchaseOrders.id,
				status: purchaseOrders.status,
				sentAt: purchaseOrders.sentAt,
				supplier: suppliers.name,
				supplierEmail: suppliers.email,
			})
			.from(purchaseOrders)
			.innerJoin(suppliers, eq(suppliers.id, purchaseOrders.supplierId))
			.where(
				and(
					sql`${connected}`,
					gte(purchaseOrders.sentAt, new Date(Date.now() - 183 * 86_400_000)),
				),
			)
			.orderBy(desc(purchaseOrders.sentAt)),
	]);
	const domain = (a: string | null) => a?.toLowerCase().split("@")[1] ?? null;
	return {
		emails: emails.map((e) => ({
			...e,
			// Which POs are this sender's supplier's, for the picker.
			likelyPos: pos
				.filter(
					(p) =>
						p.status !== "draft" &&
						p.status !== "suggested" &&
						domain(p.supplierEmail) === domain(e.fromAddress),
				)
				.map((p) => p.id),
		})),
		pos: pos
			.filter((p) => p.status !== "draft" && p.status !== "suggested")
			.map(({ supplierEmail: _, ...p }) => p),
	};
}
