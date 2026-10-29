import { and, asc, eq, inArray, isNotNull, sql } from "drizzle-orm";
import {
	createDraft,
	type Draft,
	deleteDraft,
	draftStatuses,
	readDraft,
	updateDraft,
} from "#/channels/shopify/draft-orders";
import type { Db } from "#/db/client";
import {
	repairLabor,
	repairParts,
	repairs,
	repairTools,
} from "#/db/repair-schema";
import { products } from "#/db/schema";
import { type ChargeGroup, draftLines, ourLines } from "./draft-lines";
import { lastIn } from "./queue";
import { boardStatuses } from "./status";
import { laborVariants, shopifyVariants } from "./variants";

// Keeps a repair's draft order in step with it. Every change to a repair's
// charges runs inside a transaction holding the repair's row, and writes the
// draft before committing, so a draft Shopify refused leaves nothing changed
// here either.

export class RepairError extends Error {}

// The draft was paid while staff were changing it.
export class PaidInShopify extends Error {
	constructor(readonly order: { id: string; name: string }) {
		super(`Already paid in Shopify as ${order.name}`);
	}
}

export type Locked = typeof repairs.$inferSelect;

export async function lockRepair(tx: Db, id: number): Promise<Locked> {
	const [row] = await tx
		.select()
		.from(repairs)
		.where(eq(repairs.id, id))
		.for("update");
	if (!row) throw new RepairError(`No repair R${id}`);
	return row;
}

type Tool = { id: number; tool: string; serial: string | null };

const toolLabel = (t: Tool) =>
	t.serial ? `${t.tool} (serial ${t.serial})` : t.tool;

const draftNote = (r: Locked, tools: Tool[]) =>
	[`Repair R${r.id}`, ...tools.map(toolLabel)].join("\n");

// The repair's tools, in the order they came in.
export const toolsOf = (tx: Db, id: number) =>
	tx
		.select({
			id: repairTools.id,
			tool: repairTools.tool,
			serial: repairTools.serial,
		})
		.from(repairTools)
		.where(eq(repairTools.repairId, id))
		.orderBy(asc(repairTools.id));

// The draft as it is now, or null when there isn't one. Throws
// PaidInShopify once it's been paid.
async function currentDraft(r: Locked): Promise<Draft | null> {
	if (!r.draftOrderId) return null;
	const draft = await readDraft(r.draftOrderId);
	if (draft?.status === "COMPLETED" && draft.order)
		throw new PaidInShopify(draft.order);
	// Rewriting it from one page of lines would drop the others.
	if (draft?.lineItems.pageInfo.hasNextPage)
		throw new RepairError(
			`${draft.name} has more lines than can be read; change it in Shopify`,
		);
	return draft;
}

// Writes the repair's charges onto its draft order: made with the first,
// deleted with the last, unless Shopify added lines of its own. `charges:
// false` takes all of the repair's off, as when it's cancelled.
export async function syncDraft(
	tx: Db,
	r: Locked,
	{ charges = true }: { charges?: boolean } = {},
) {
	if (r.kind === "bench")
		throw new RepairError(`R${r.id} is ours; it has no draft order`);
	const tools = await toolsOf(tx, r.id);
	const labor = await tx
		.select({ toolId: repairLabor.toolId, minutes: repairLabor.minutes })
		.from(repairLabor)
		.where(eq(repairLabor.repairId, r.id));
	const parts = await tx
		.select({
			toolId: repairParts.toolId,
			productId: repairParts.productId,
			quantity: repairParts.quantity,
			sku: products.sku,
		})
		.from(repairParts)
		.innerJoin(products, eq(products.id, repairParts.productId))
		.where(eq(repairParts.repairId, r.id))
		.orderBy(asc(repairParts.id));
	const variantOf = await shopifyVariants(
		tx,
		parts.map((p) => p.productId),
	);
	const missing = parts.filter((p) => !variantOf.has(p.productId));
	if (charges && missing.length > 0)
		throw new RepairError(
			`Not sold on Shopify, so it can't be charged: ${missing.map((p) => p.sku).join(", ")}`,
		);
	// Each tool, then the order's own.
	const groups: ChargeGroup[] = charges
		? [
				...tools.map((t) => ({ toolId: t.id, label: toolLabel(t) })),
				{ toolId: null, label: null },
			].map((g) => ({
				...g,
				laborMinutes: labor
					.filter((l) => l.toolId === g.toolId)
					.reduce((n, l) => n + l.minutes, 0),
				parts: parts.flatMap((p) => {
					const variantId = variantOf.get(p.productId);
					return p.toolId === g.toolId && variantId
						? [{ variantId, quantity: p.quantity }]
						: [];
				}),
			}))
		: [];
	const ours = ourLines(
		{ repairId: r.id, groups },
		groups.some((g) => g.laborMinutes > 0) ? await laborVariants() : [],
	);
	const draft = await currentDraft(r);
	const lineItems = draftLines(draft?.lineItems.nodes ?? [], ours);
	const input = {
		customerId: r.customerId ?? undefined,
		note: draftNote(r, tools),
		lineItems,
	};
	let next: { id: string; name: string } | null;
	if (lineItems.length === 0) {
		if (draft) await deleteDraft(draft.id);
		next = null;
	} else if (draft) {
		next = await updateDraft(draft.id, input);
	} else {
		next = await createDraft({ ...input, tags: ["repair", `R${r.id}`] });
	}
	// A draft that kept only Shopify's own lines isn't this repair's any more.
	if (!charges) next = null;
	await tx
		.update(repairs)
		.set({ draftOrderId: next?.id ?? null, draftOrderName: next?.name ?? null })
		.where(eq(repairs.id, r.id));
	return next;
}

// Records that the draft was paid. Only moves a repair still on the board,
// so a late or repeated word from Shopify changes nothing.
export async function markPaid(
	db: Db,
	id: number,
	order: { id: string; name: string },
) {
	const moved = await db
		.update(repairs)
		.set({
			status: "picked_up",
			orderId: order.id,
			orderName: order.name,
			draftOrderId: null,
			draftOrderName: null,
			statusChangedAt: sql`now()`,
			position: await lastIn(db, "picked_up", id),
		})
		.where(and(eq(repairs.id, id), inArray(repairs.status, [...boardStatuses])))
		.returning({ id: repairs.id });
	return moved.length > 0;
}

// Asks Shopify about every open repair's draft: a paid one moves to Picked
// up, and one deleted in Shopify is let go, to be made again with the next
// charge. Says how many changed.
export async function refreshDrafts(db: Db) {
	const open = await db
		.select({ id: repairs.id, draftOrderId: repairs.draftOrderId })
		.from(repairs)
		.where(
			and(
				inArray(repairs.status, [...boardStatuses]),
				isNotNull(repairs.draftOrderId),
			),
		);
	let changed = 0;
	for (let i = 0; i < open.length; i += 100) {
		const chunk = open.slice(i, i + 100);
		const found = new Map(
			(await draftStatuses(chunk.flatMap((r) => r.draftOrderId ?? []))).map(
				(d) => [d.id, d],
			),
		);
		for (const r of chunk) {
			if (!r.draftOrderId) continue;
			const d = found.get(r.draftOrderId);
			if (d?.status === "COMPLETED" && d.order) {
				if (await markPaid(db, r.id, d.order)) changed++;
			} else if (!d) {
				const released = await db
					.update(repairs)
					.set({ draftOrderId: null, draftOrderName: null })
					.where(
						and(eq(repairs.id, r.id), eq(repairs.draftOrderId, r.draftOrderId)),
					)
					.returning({ id: repairs.id });
				changed += released.length;
			}
		}
	}
	return changed;
}
