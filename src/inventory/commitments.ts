import { eq, inArray, sql } from "drizzle-orm";
import type { Db } from "#/db/client";
import { orderLines, orders, stores } from "#/db/schema";
import {
	committedStock,
	quantityMode,
	stockCommitmentEntries,
	stockCommitmentParts,
	stockCommitments,
} from "#/db/quantity-schema";

export type Part = { productId: number; perUnit: number };

export type QuantityMode = (typeof quantityMode.$inferSelect)["mode"];

export class CommitmentError extends Error {
	name = "CommitmentError";
}

export async function readQuantityMode(
	db: Db,
	hold: "share" | "update" | "none" = "share",
): Promise<QuantityMode> {
	const query = db
		.select({ mode: quantityMode.mode })
		.from(quantityMode)
		.where(eq(quantityMode.id, 1));
	const [row] = await (hold === "none" ? query : query.for(hold));
	if (!row) throw new Error("The quantity_mode row is missing");
	return row.mode;
}

export type Revision = {
	id: number;
	revision: number;
	productId: number;
	quantity: number;
	consumed: number;
	released: number;
	remaining: number;
	parts: Part[];
};

export type LineHistory = {
	orderLineId: number;
	revisions: Revision[];
	latest: Revision | null;
	open: Revision[];
	consumed: number;
	remaining: number;
};

export async function lineHistories(
	db: Db,
	orderLineIds: number[],
): Promise<Map<number, LineHistory>> {
	const result = new Map<number, LineHistory>();
	const ids = [...new Set(orderLineIds)];
	for (const id of ids)
		result.set(id, {
			orderLineId: id,
			revisions: [],
			latest: null,
			open: [],
			consumed: 0,
			remaining: 0,
		});
	if (ids.length === 0) return result;
	const rows = await db
		.select({
			id: stockCommitments.id,
			orderLineId: stockCommitments.orderLineId,
			revision: stockCommitments.revision,
			productId: stockCommitments.productId,
			quantity: stockCommitments.quantity,
			consumed: sql<number>`coalesce((select sum(case ${stockCommitmentEntries.kind} when 'consume' then ${stockCommitmentEntries.quantity} when 'restore' then -${stockCommitmentEntries.quantity} else 0 end) from ${stockCommitmentEntries} where ${stockCommitmentEntries.commitmentId} = ${stockCommitments.id}), 0)::int`,
			released: sql<number>`coalesce((select sum(${stockCommitmentEntries.quantity}) from ${stockCommitmentEntries} where ${stockCommitmentEntries.commitmentId} = ${stockCommitments.id} and ${stockCommitmentEntries.kind} = 'release'), 0)::int`,
		})
		.from(stockCommitments)
		.where(inArray(stockCommitments.orderLineId, ids))
		.orderBy(stockCommitments.orderLineId, stockCommitments.revision);
	const parts =
		rows.length === 0
			? []
			: await db
					.select()
					.from(stockCommitmentParts)
					.where(
						inArray(
							stockCommitmentParts.commitmentId,
							rows.map((r) => r.id),
						),
					)
					.orderBy(stockCommitmentParts.productId);
	for (const row of rows) {
		const history = result.get(row.orderLineId);
		if (!history) continue;
		const revision: Revision = {
			id: row.id,
			revision: row.revision,
			productId: row.productId,
			quantity: row.quantity,
			consumed: row.consumed,
			released: row.released,
			remaining: row.quantity - row.consumed - row.released,
			parts: parts
				.filter((p) => p.commitmentId === row.id)
				.map((p) => ({ productId: p.productId, perUnit: p.perUnit })),
		};
		history.revisions.push(revision);
		history.latest = revision;
		history.consumed += revision.consumed;
		history.remaining += revision.remaining;
		if (revision.remaining > 0) history.open.push(revision);
	}
	return result;
}

export async function lineHistory(db: Db, orderLineId: number) {
	const history = (await lineHistories(db, [orderLineId])).get(orderLineId);
	if (!history) throw new Error(`No history for order line ${orderLineId}`);
	return history;
}

export type Settlement =
	| { kind: "unchanged"; remaining: number }
	| { kind: "reserved"; commitmentId: number; quantity: number }
	| { kind: "released"; quantity: number }
	| {
			kind: "revised";
			released: number;
			commitmentId: number;
			quantity: number;
	  }
	| { kind: "overshipped"; consumed: number; target: number };

export async function settleLine(
	db: Db,
	input: {
		orderLineId: number;
		orderId: number;
		productId: number;
		target: number;
		freshParts: () => Promise<Part[] | null>;
		legacySaleBatchId?: string;
	},
): Promise<Settlement> {
	if (!Number.isInteger(input.target) || input.target < 0)
		throw new CommitmentError(
			`A line commits a whole number from 0, got ${input.target}`,
		);
	return db.transaction(async (tx) => {
		const history = await lineHistory(tx, input.orderLineId);
		const { latest } = history;
		const sameProduct = latest?.productId === input.productId;
		const accounted = history.consumed + history.remaining;
		if (sameProduct && accounted === input.target)
			return { kind: "unchanged", remaining: history.remaining } as const;
		if (!latest && input.target === 0)
			return { kind: "unchanged", remaining: 0 } as const;
		const released = history.remaining;
		if (history.open.length > 0)
			await tx.insert(stockCommitmentEntries).values(
				history.open.map((r) => ({
					commitmentId: r.id,
					kind: "release" as const,
					quantity: r.remaining,
				})),
			);
		const quantity = input.target - history.consumed;
		if (quantity < 0)
			return {
				kind: "overshipped",
				consumed: history.consumed,
				target: input.target,
			} as const;
		if (quantity === 0) return { kind: "released", quantity: released } as const;
		const parts =
			sameProduct && latest ? latest.parts : await input.freshParts();
		if (!parts || parts.length === 0)
			throw new CommitmentError(
				`Product ${input.productId} has no parts to reserve`,
			);
		const [made] = await tx
			.insert(stockCommitments)
			.values({
				orderLineId: input.orderLineId,
				orderId: input.orderId,
				revision: (latest?.revision ?? 0) + 1,
				productId: input.productId,
				quantity,
				source: input.legacySaleBatchId ? "activation" : "order",
				legacySaleBatchId: input.legacySaleBatchId ?? null,
			})
			.returning({ id: stockCommitments.id });
		await tx
			.insert(stockCommitmentParts)
			.values(parts.map((p) => ({ ...p, commitmentId: made.id })));
		return latest
			? ({ kind: "revised", released, commitmentId: made.id, quantity } as const)
			: ({ kind: "reserved", commitmentId: made.id, quantity } as const);
	});
}

export async function committedUnits(
	db: Db,
	productIds: number[],
): Promise<Map<number, number>> {
	const result = new Map<number, number>();
	if (productIds.length === 0) return result;
	const rows = await db
		.select()
		.from(committedStock)
		.where(inArray(committedStock.productId, productIds));
	for (const row of rows) result.set(row.productId, row.units);
	return result;
}

export async function committedDrift(db: Db) {
	const result = (await db.execute(sql`
		with derived as (
			select p.product_id, sum(p.per_unit * (c.quantity - commitment_settled(c.id)))::int as units
			from ${stockCommitmentParts} p
			join ${stockCommitments} c on c.id = p.commitment_id
			group by p.product_id
		)
		select coalesce(d.product_id, s.product_id) as product_id,
			coalesce(s.units, 0) as kept, coalesce(d.units, 0) as derived
		from derived d
		full join ${committedStock} s on s.product_id = d.product_id
		where coalesce(s.units, 0) <> coalesce(d.units, 0)
	`)) as unknown as {
		rows: { product_id: number; kept: number; derived: number }[];
	};
	return result.rows.map((r) => ({
		productId: Number(r.product_id),
		kept: Number(r.kept),
		derived: Number(r.derived),
	}));
}

export function hasCommitment(orderLineId: unknown) {
	return sql<boolean>`exists (select 1 from ${stockCommitments} where ${stockCommitments.orderLineId} = ${orderLineId})`;
}

export function partsFor(
	product: { id: number; kind: string },
	recipes: Map<number, { productId: number; quantity: number }[]>,
): Part[] | null {
	if (product.kind !== "bundle") return [{ productId: product.id, perUnit: 1 }];
	const parts = recipes.get(product.id) ?? [];
	return parts.length === 0
		? null
		: parts.map((p) => ({ productId: p.productId, perUnit: p.quantity }));
}

export type LineTarget = {
	orderLineId: number;
	orderId: number;
	productId: number | null;
	target: number;
};

export async function lineTargets(
	db: Db,
	orderLineIds: number[],
): Promise<LineTarget[]> {
	if (orderLineIds.length === 0) return [];
	return db
		.select({
			orderLineId: orderLines.id,
			orderId: orderLines.orderId,
			productId: orderLines.productId,
			target: sql<number>`(case when ${orderLines.productId} is not null
				and not ${orders.fulfilledByChannel} and not ${orders.soldInStore}
				and ${orders.cancelledAt} is null and ${stores.stockFrom} is not null
				and ${orders.placedAt} >= ${stores.stockFrom}
				then greatest(${orderLines.quantity}, 0) else 0 end)::int`,
		})
		.from(orderLines)
		.innerJoin(orders, eq(orders.id, orderLines.orderId))
		.innerJoin(stores, eq(stores.id, orders.storeId))
		.where(inArray(orderLines.id, orderLineIds))
		.orderBy(orderLines.id);
}
