import { and, desc, eq, inArray, ne, notInArray, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import type { Db } from "#/db/client";
import { repairs } from "#/db/repair-schema";
import {
	orderLines,
	orderProfit,
	orderReturns,
	orders,
	products,
	returnRefunds,
	returnRequests,
	stores,
} from "#/db/schema";
import { type AdminPage, returnPage } from "./admin-urls";
import {
	type Decision,
	type RefundDecisionKind,
	refundStep,
} from "./refund-step";

// The Refunds view: every order with something checked in (or benched)
// from a return, what came back and what whoever checked it in saw, what
// the buyer said, what's refunded, and the newest decision about the rest.
// Server only; where each stands is refundStep's.

// How long a settled one stays listed, to undo. Nothing still open ages
// out.
const DONE_DAYS = 14;

export type TriagedItem = {
	key: string;
	title: string;
	sku: string | null;
	imageUrl: string | null;
	quantity: number;
	outcome: "restocked" | "refurbished" | "written_off" | "bench";
	// The refurb's SKU, or the bench job's id.
	ref: string | null;
	note: string | null;
	at: Date;
};

export type RefundRow = {
	orderId: number;
	name: string;
	channel: (typeof stores.$inferSelect)["channel"];
	salesChannel: string | null;
	customerName: string | null;
	placedAt: Date;
	page: AdminPage | null;
	items: TriagedItem[];
	triagedAt: Date;
	// What the items checked in sold for.
	itemValue: number;
	refundedNow: number;
	decision: Decision | null;
	// The newest return the buyer opened, if they opened one.
	request: {
		reason: string | null;
		note: string | null;
		amount: string | null;
		currency: string | null;
		billedBy: (typeof returnRequests.$inferSelect)["billedBy"];
	} | null;
};

const refurbs = alias(products, "refurbs");

// A unit refurbished off the bench is received when it's listed, long after
// it was checked in: it counts as checked in when it went on the bench, with
// what was noted then, so listing it doesn't reopen its decision.
// A bench job's one tool's problem.
const firstProblem = (repairId: string) =>
	`(select t.problem from repair_tools t where t.repair_id = ${repairId} order by t.id limit 1)`;

const benchedAs = (field: "created_at" | "problem") =>
	sql.raw(`(select ${field === "problem" ? `nullif(btrim(${firstProblem("b.id")}), '')` : "b.created_at"}
		from repairs b
		where b.kind = 'bench' and b.status = 'refurbished'
			and b.return_line_id = "order_returns"."order_line_id"
			and b.refurb_product_id = "order_returns"."refurb_product_id"
		order by b.created_at limit 1)`);

export async function listRefundQueue(db: Db): Promise<RefundRow[]> {
	const [back, benched] = await Promise.all([
		db
			.select({
				id: orderReturns.id,
				orderId: orderLines.orderId,
				title: orderLines.title,
				sku: sql<string | null>`coalesce(${products.sku}, ${orderLines.sku})`,
				imageUrl: products.imageUrl,
				unitPrice: orderLines.unitPrice,
				quantity: orderReturns.quantity,
				restocked: orderReturns.restocked,
				refurbSku: refurbs.sku,
				note: sql<
					string | null
				>`coalesce(${orderReturns.note}, ${benchedAs("problem")})`,
				at: sql<Date>`coalesce(${benchedAs("created_at")}, ${orderReturns.createdAt})`.mapWith(
					orderReturns.createdAt,
				),
			})
			.from(orderReturns)
			.innerJoin(orderLines, eq(orderLines.id, orderReturns.orderLineId))
			.leftJoin(products, eq(products.id, orderLines.productId))
			.leftJoin(refurbs, eq(refurbs.id, orderReturns.refurbProductId))
			.where(eq(orderReturns.preCutover, false)),
		// A bench job's unit is listed as a refurb when it's done, and is
		// then one of the returns above.
		db
			.select({
				id: repairs.id,
				orderId: orderLines.orderId,
				title: orderLines.title,
				sku: sql<string | null>`coalesce(${products.sku}, ${orderLines.sku})`,
				imageUrl: products.imageUrl,
				unitPrice: orderLines.unitPrice,
				note: sql<string>`${sql.raw(firstProblem('"repairs"."id"'))}`,
				at: repairs.createdAt,
			})
			.from(repairs)
			.innerJoin(orderLines, eq(orderLines.id, repairs.returnLineId))
			.leftJoin(products, eq(products.id, orderLines.productId))
			.where(
				and(
					eq(repairs.kind, "bench"),
					notInArray(repairs.status, ["cancelled", "refurbished"]),
				),
			),
	]);
	const items = new Map<number, (TriagedItem & { value: number })[]>();
	const add = (orderId: number, item: TriagedItem & { value: number }) =>
		items.set(orderId, [...(items.get(orderId) ?? []), item]);
	for (const r of back)
		add(r.orderId, {
			key: `r${r.id}`,
			title: r.title,
			sku: r.sku,
			imageUrl: r.imageUrl,
			quantity: r.quantity,
			outcome: r.refurbSku
				? "refurbished"
				: r.restocked
					? "restocked"
					: "written_off",
			ref: r.refurbSku,
			note: r.note,
			at: r.at,
			value: r.unitPrice * r.quantity,
		});
	for (const b of benched)
		add(b.orderId, {
			key: `b${b.id}`,
			title: b.title,
			sku: b.sku,
			imageUrl: b.imageUrl,
			quantity: 1,
			outcome: "bench",
			ref: `R${b.id}`,
			note: b.note.trim() || null,
			at: b.at,
			value: b.unitPrice,
		});
	const ids = [...items.keys()];
	if (ids.length === 0) return [];

	const [found, decisions, requests] = await Promise.all([
		db
			.select({
				id: orders.id,
				name: orders.name,
				channel: stores.channel,
				salesChannel: orders.salesChannel,
				externalId: orders.externalId,
				marketplaceOrderId: orders.marketplaceOrderId,
				customerName: orders.customerName,
				placedAt: orders.placedAt,
				soldOn: orderProfit.soldOn,
				refunded: sql<number>`coalesce(${orderProfit.refunds}, 0)::float8`,
			})
			.from(orders)
			.innerJoin(stores, eq(stores.id, orders.storeId))
			.leftJoin(orderProfit, eq(orderProfit.orderId, orders.id))
			.where(inArray(orders.id, ids)),
		db
			.select()
			.from(returnRefunds)
			.where(inArray(returnRefunds.orderId, ids))
			.orderBy(desc(returnRefunds.decidedAt), desc(returnRefunds.id)),
		db
			.select({
				orderId: returnRequests.orderId,
				reason: returnRequests.reason,
				note: returnRequests.note,
				amount: returnRequests.amount,
				currency: returnRequests.currency,
				billedBy: returnRequests.billedBy,
			})
			.from(returnRequests)
			.where(
				and(
					inArray(returnRequests.orderId, ids),
					eq(returnRequests.kind, "return"),
				),
			)
			.orderBy(desc(returnRequests.requestedAt)),
	]);

	const done = Date.now() - DONE_DAYS * 86_400_000;
	return found
		.map((o): RefundRow => {
			const mine = (items.get(o.id) ?? []).sort(
				(a, b) => a.at.getTime() - b.at.getTime(),
			);
			const request = requests.find((r) => r.orderId === o.id) ?? null;
			const latest = decisions.find((d) => d.orderId === o.id);
			return {
				orderId: o.id,
				name: o.name,
				channel: o.channel,
				salesChannel: o.salesChannel,
				customerName: o.customerName,
				placedAt: o.placedAt,
				page: returnPage(o, request?.billedBy ?? o.soldOn ?? o.channel),
				items: mine.map(({ value: _, ...i }) => i),
				triagedAt: mine[mine.length - 1].at,
				itemValue: mine.reduce((n, i) => n + i.value, 0),
				refundedNow: o.refunded,
				decision: latest ? decisionOf(latest) : null,
				request: request && {
					reason: request.reason,
					note: request.note,
					amount: request.amount,
					currency: request.currency,
					billedBy: request.billedBy,
				},
			};
		})
		.filter((r) => {
			const step = refundStep(r);
			if (step.kind !== "done") return true;
			const at = step.decision.settledAt ?? step.decision.decidedAt;
			return at.getTime() >= done;
		})
		.sort((a, b) => a.triagedAt.getTime() - b.triagedAt.getTime());
}

const decisionOf = (d: typeof returnRefunds.$inferSelect): Decision => ({
	id: d.id,
	decision: d.decision,
	amount: d.amount,
	note: d.note,
	refundedBefore: d.refundedBefore,
	decidedAt: d.decidedAt,
	settledAt: d.settledAt,
});

export class RefundDecisionError extends Error {
	name = "RefundDecisionError";
}

// Records what to do about an order's refund. after is the decision it was
// decided over (null for none), so two people deciding the same order
// can't both win: the second is told to look again.
export async function decideRefund(
	db: Db,
	input: {
		orderId: number;
		decision: RefundDecisionKind;
		amount: number | null;
		note: string | null;
		after: number | null;
	},
): Promise<Decision> {
	const note = input.note?.trim() || null;
	if (input.decision === "partial" && !(input.amount && input.amount > 0))
		throw new RefundDecisionError("Say how much to refund");
	if (input.decision === "other" && !note)
		throw new RefundDecisionError("Say what needs doing");
	return db.transaction(async (tx) => {
		const [order] = await tx
			.select({ id: orders.id })
			.from(orders)
			.where(eq(orders.id, input.orderId))
			.for("update");
		if (!order) throw new RefundDecisionError(`No order ${input.orderId}`);
		const [latest] = await tx
			.select({ id: returnRefunds.id })
			.from(returnRefunds)
			.where(eq(returnRefunds.orderId, order.id))
			.orderBy(desc(returnRefunds.decidedAt), desc(returnRefunds.id))
			.limit(1);
		if ((latest?.id ?? null) !== input.after)
			throw new RefundDecisionError(
				"Someone else just decided this one; it's been reloaded",
			);
		const [profit] = await tx
			.select({ refunds: orderProfit.refunds })
			.from(orderProfit)
			.where(eq(orderProfit.orderId, order.id));
		const [row] = await tx
			.insert(returnRefunds)
			.values({
				orderId: order.id,
				decision: input.decision,
				amount: input.decision === "partial" ? input.amount : null,
				note,
				refundedBefore: profit?.refunds ?? 0,
			})
			.returning();
		return decisionOf(row);
	});
}

// Takes a decision back, for Undo: the one before it counts again.
export async function undoRefundDecision(db: Db, id: number) {
	await db.delete(returnRefunds).where(eq(returnRefunds.id, id));
}

// Says a refund was made (or something else was resolved), when the
// marketplace's charges don't show it; or takes that back.
export async function settleRefund(db: Db, id: number, settled: boolean) {
	await db
		.update(returnRefunds)
		.set({ settledAt: settled ? new Date() : null })
		.where(and(eq(returnRefunds.id, id), ne(returnRefunds.decision, "none")));
}
