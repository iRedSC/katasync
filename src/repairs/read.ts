import { and, asc, desc, eq, gte, inArray, or, sql } from "drizzle-orm";
import { readDraft } from "#/channels/shopify/draft-orders";
import type { Db } from "#/db/client";
import { people, repairLabor, repairParts, repairs } from "#/db/repair-schema";
import {
	locations,
	orderLines,
	orders,
	products,
	stockLevels,
} from "#/db/schema";
import { isOurs as isOurLocation } from "#/inventory/locations";
import { isOurs } from "./draft-lines";
import { markPaid } from "./draft-sync";
import { boardStatuses } from "./status";
import { laborVariants, shopifyVariants } from "./variants";

// Reading repairs: the board, and one repair with its draft order as
// Shopify has it now.

const card = {
	id: repairs.id,
	status: repairs.status,
	kind: repairs.kind,
	productId: repairs.productId,
	imageUrl: sql<
		string | null
	>`(select p.image_url from ${products} p where p.id = ${repairs.productId})`,
	// A bench job's: the order its unit came back from, and its refurb once
	// listed.
	returnOrderId: sql<
		number | null
	>`(select l.order_id from ${orderLines} l where l.id = ${repairs.returnLineId})`,
	returnOrderName: sql<
		string | null
	>`(select o.name from ${orderLines} l join ${orders} o on o.id = l.order_id where l.id = ${repairs.returnLineId})`,
	refurbSku: sql<
		string | null
	>`(select p.sku from ${products} p where p.id = ${repairs.refurbProductId})`,
	refurbProductId: repairs.refurbProductId,
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
	position: repairs.position,
	createdAt: repairs.createdAt,
	laborMinutes: sql<number>`(select coalesce(sum(minutes), 0)::int from ${repairLabor} where repair_id = ${repairs.id})`,
	parts: sql<number>`(select coalesce(sum(quantity), 0)::int from ${repairParts} where repair_id = ${repairs.id})`,
};

// Everything on the board, each column in its queue's order
// (src/repairs/queue.ts), and what was picked up or listed in the last
// week.
export async function boardRepairs(db: Db) {
	return db
		.select(card)
		.from(repairs)
		.leftJoin(people, eq(people.id, repairs.technicianId))
		.where(
			or(
				inArray(repairs.status, [...boardStatuses]),
				and(
					inArray(repairs.status, ["picked_up", "refurbished"]),
					gte(repairs.statusChangedAt, sql`now() - interval '7 days'`),
				),
			),
		)
		.orderBy(asc(repairs.position), asc(repairs.id));
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
	// What Shopify charges for each of our part lines, by variant.
	const charged = new Map<string, { each: number; total: number }>();
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
				for (const l of lines)
					if (isOurs(l) && l.variant)
						charged.set(l.variant.id, {
							each: Number(l.originalUnitPriceSet.shopMoney.amount),
							total: total(l),
						});
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
			// What a bench job's refurb is charged for it, at its average now.
			unitCost: products.unitCost,
			// Number | null: a part just added shows none until this is read.
			onHand: sql<
				number | null
			>`(select coalesce(sum(s.on_hand), 0)::int from ${stockLevels} s join ${locations} on ${locations.id} = s.location_id where s.product_id = ${repairParts.productId} and ${isOurLocation})`,
		})
		.from(repairParts)
		.innerJoin(products, eq(products.id, repairParts.productId))
		.where(eq(repairParts.repairId, id))
		.orderBy(asc(repairParts.id));
	const onShopify = await shopifyVariants(
		db,
		parts.map((p) => p.productId),
	);
	const variants =
		row.kind === "bench" ? null : await laborVariants().catch(() => null);
	return {
		repair: row,
		labor,
		parts: parts.map((p) => {
			const variant = onShopify.get(p.productId);
			return {
				...p,
				onShopify: variant !== undefined,
				// Null until the draft has it, or when Shopify can't be read.
				charged: variant === undefined ? null : (charged.get(variant) ?? null),
			};
		}),
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
