import { createServerFn } from "@tanstack/react-start";
import { type } from "arktype";
import { and, desc, eq, gte, sql } from "drizzle-orm";
import { type Db, getDb } from "#/db/client";
import { purchaseOrders, suppliers } from "#/db/schema";
import { inboxAddress } from "#/purchasing/inbox/graph";
import { fileEmail, setAside, unfiledEmails } from "#/purchasing/inbox/ingest";
import { addTracking, removeTracking } from "#/purchasing/tracking";
import { id } from "./id-input";

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

export const filePoEmail = createServerFn({ method: "POST" })
	.validator(
		type({
			emailId: "number.integer > 0",
			purchaseOrderId: "number.integer > 0 | null",
		}),
	)
	.handler(async ({ data }) => fileEmail(getDb(), { ...data, by: "staff" }));

export const setAsidePoEmail = createServerFn({ method: "POST" })
	.validator(type({ id: "number.integer > 0", aside: "boolean" }))
	.handler(async ({ data }) => setAside(getDb(), data.id, data.aside));

export const addPoTracking = createServerFn({ method: "POST" })
	.validator(
		type({
			purchaseOrderId: "number.integer > 0",
			number: "string > 0",
			"carrier?": "'ups' | 'usps' | 'fedex'",
		}),
	)
	.handler(async ({ data }) => addTracking(getDb(), data));

export const removePoTracking = createServerFn({ method: "POST" })
	.validator(id)
	.handler(async ({ data }) => removeTracking(getDb(), data.id));
