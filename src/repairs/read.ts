import { and, asc, desc, eq, gte, inArray, or, sql } from "drizzle-orm";
import { readDraft } from "#/channels/shopify/draft-orders";
import type { Db } from "#/db/client";
import { people, repairLabor, repairParts, repairs } from "#/db/repair-schema";
import { products } from "#/db/schema";
import { isOurs } from "./draft-lines";
import { markPaid } from "./draft-sync";
import { boardStatuses } from "./status";
import { laborVariants, shopifyVariants } from "./variants";

// Reading repairs: the board, and one repair with its draft order as
// Shopify has it now.

const card = {
	id: repairs.id,
	status: repairs.status,
	customerId: repairs.customerId,
	customerName: repairs.customerName,
	customerPhone: repairs.customerPhone,
	tool: repairs.tool,
	serial: repairs.serial,
	problem: repairs.problem,
	technicianId: repairs.technicianId,
	technician: people.name,
	draftOrderName: repairs.draftOrderName,
	orderName: repairs.orderName,
	statusChangedAt: repairs.statusChangedAt,
	createdAt: repairs.createdAt,
	laborMinutes: sql<number>`(select coalesce(sum(minutes), 0)::int from ${repairLabor} where repair_id = ${repairs.id})`,
	parts: sql<number>`(select coalesce(sum(quantity), 0)::int from ${repairParts} where repair_id = ${repairs.id})`,
};

// Everything on the board, oldest in each column first, and what was
// picked up in the last week.
export async function boardRepairs(db: Db) {
	return db
		.select(card)
		.from(repairs)
		.leftJoin(people, eq(people.id, repairs.technicianId))
		.where(
			or(
				inArray(repairs.status, [...boardStatuses]),
				and(
					eq(repairs.status, "picked_up"),
					gte(repairs.statusChangedAt, sql`now() - interval '7 days'`),
				),
			),
		)
		.orderBy(asc(repairs.statusChangedAt));
}
export type RepairCard = Awaited<ReturnType<typeof boardRepairs>>[number];

// A customer's repairs, newest first.
export async function customerRepairs(db: Db, customerId: string) {
	return db
		.select(card)
		.from(repairs)
		.leftJoin(people, eq(people.id, repairs.technicianId))
		.where(eq(repairs.customerId, customerId))
		.orderBy(desc(repairs.createdAt));
}

// How many repairs each customer has still in the shop.
export async function openCounts(db: Db, customerIds: string[]) {
	if (customerIds.length === 0) return new Map<string, number>();
	const rows = await db
		.select({
			customerId: repairs.customerId,
			open: sql<number>`count(*)::int`,
		})
		.from(repairs)
		.where(
			and(
				inArray(repairs.customerId, customerIds),
				inArray(repairs.status, [...boardStatuses]),
			),
		)
		.groupBy(repairs.customerId);
	return new Map(rows.map((r) => [r.customerId, r.open]));
}

export type DraftView =
	| { kind: "none" }
	| { kind: "unreadable"; error: string }
	| {
			kind: "open";
			id: string;
			name: string;
			invoiceSentAt: string | null;
			subtotal: number;
			tax: number;
			total: number;
			// Lines added in Shopify, which the repair doesn't own.
			others: {
				uuid: string;
				title: string;
				quantity: number;
				total: number;
			}[];
			// What Shopify charges for the repair's own lines.
			ours: number;
	  };

export async function getRepair(db: Db, id: number) {
	const [row] = await db
		.select({
			...card,
			customerEmail: repairs.customerEmail,
			notes: repairs.notes,
			draftOrderId: repairs.draftOrderId,
			orderId: repairs.orderId,
		})
		.from(repairs)
		.leftJoin(people, eq(people.id, repairs.technicianId))
		.where(eq(repairs.id, id));
	if (!row) return null;
	let draft: DraftView = { kind: "none" };
	if (row.draftOrderId) {
		try {
			const d = await readDraft(row.draftOrderId);
			if (d?.status === "COMPLETED" && d.order) {
				// Paid since we last looked.
				await markPaid(db, id, d.order);
				return getRepair(db, id);
			}
			if (d) {
				const lines = d.lineItems.nodes;
				const total = (l: (typeof lines)[number]) =>
					Number(l.discountedTotalSet.shopMoney.amount);
				draft = {
					kind: "open",
					id: d.id,
					name: d.name,
					invoiceSentAt: d.invoiceSentAt,
					subtotal: Number(d.subtotalPriceSet.shopMoney.amount),
					tax: Number(d.totalTaxSet.shopMoney.amount),
					total: Number(d.totalPriceSet.shopMoney.amount),
					others: lines
						.filter((l) => !isOurs(l))
						.map((l) => ({
							uuid: l.uuid,
							title: l.title,
							quantity: l.quantity,
							total: total(l),
						})),
					ours: lines.filter(isOurs).reduce((n, l) => n + total(l), 0),
				};
			}
		} catch (error) {
			draft = {
				kind: "unreadable",
				error: error instanceof Error ? error.message : String(error),
			};
		}
	}
	const labor = await db
		.select({
			id: repairLabor.id,
			minutes: repairLabor.minutes,
			note: repairLabor.note,
			createdAt: repairLabor.createdAt,
		})
		.from(repairLabor)
		.where(eq(repairLabor.repairId, id))
		.orderBy(asc(repairLabor.id));
	const parts = await db
		.select({
			productId: repairParts.productId,
			quantity: repairParts.quantity,
			sku: products.sku,
			name: products.name,
			variantName: products.variantName,
			imageUrl: products.imageUrl,
		})
		.from(repairParts)
		.innerJoin(products, eq(products.id, repairParts.productId))
		.where(eq(repairParts.repairId, id))
		.orderBy(asc(repairParts.id));
	const onShopify = await shopifyVariants(
		db,
		parts.map((p) => p.productId),
	);
	const variants = await laborVariants().catch(() => null);
	return {
		repair: row,
		labor,
		parts: parts.map((p) => ({ ...p, onShopify: onShopify.has(p.productId) })),
		draft,
		laborVariants: variants,
	};
}
export type RepairDetail = NonNullable<Awaited<ReturnType<typeof getRepair>>>;

// Tools in the shop not fixed yet: on the board, short of Ready.
export async function countRepairsToDo(db: Db) {
	const [row] = await db
		.select({ n: sql<number>`count(*)::int` })
		.from(repairs)
		.where(inArray(repairs.status, ["received", "waiting_parts", "in_repair"]));
	return row.n;
}
