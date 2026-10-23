import { createHash } from "node:crypto";
import { and, eq, inArray, isNotNull, sql } from "drizzle-orm";
import type { Db } from "#/db/client";
import { quantityMode } from "#/db/quantity-schema";
import {
	dispatchOrders,
	locations,
	movements,
	orderLines,
	orders,
	shipments,
	stockLevels,
} from "#/db/schema";
import { undoBatch } from "#/inventory/ledger";
import { lockBatchProducts } from "#/inventory/ledger/post";
import {
	committedDrift,
	committedUnits,
	lineHistories,
	type Part,
	readQuantityMode,
	settleLine,
} from "./commitments";
import { consumeCommitments } from "./commitments-consume";
import { ourKinds } from "./locations";

export class ActivationError extends Error {
	name = "ActivationError";
}

export class ActivationBlocked extends ActivationError {
	name = "ActivationBlocked";
	readonly unresolved: UnresolvedLine[];
	constructor(unresolved: UnresolvedLine[]) {
		super(
			`${unresolved.length} legacy sale line(s) need a shipped quantity: ${unresolved
				.slice(0, 20)
				.map((u) => `${u.orderName} line ${u.orderLineId} (${u.why})`)
				.join(", ")}`,
		);
		this.unresolved = unresolved;
	}
}

export type Candidate = {
	orderLineId: number;
	orderId: number;
	orderName: string;
	productId: number | null;
	quantity: number;
	saleBatchId: string;
	cancelled: boolean;
	soldInStore: boolean;
	fulfilledByChannel: boolean;
	fulfillmentStatus: string;
	liveDispatch: boolean;
};

export type UnresolvedWhy =
	| "partially_fulfilled"
	| "label_without_shipped_status"
	| "unknown_status"
	| "cancelled_sale_not_undone"
	| "channel_fulfilled_with_sale"
	| "uneven_sale_batch";

export type Decision =
	| { kind: "keep"; why: "pos" | "shipped" }
	| { kind: "convert" }
	| { kind: "unresolved"; why: UnresolvedWhy };

const WAITING = new Set(["UNFULFILLED", "ON_HOLD", "AWAITING_PAYMENT"]);
const GONE = new Set(["FULFILLED", "FULFILLMENT_NOT_REQUIRED"]);

export function classifyLegacyLine(c: Candidate): Decision {
	if (c.cancelled) return { kind: "unresolved", why: "cancelled_sale_not_undone" };
	if (c.fulfilledByChannel)
		return { kind: "unresolved", why: "channel_fulfilled_with_sale" };
	if (c.soldInStore) return { kind: "keep", why: "pos" };
	if (GONE.has(c.fulfillmentStatus)) return { kind: "keep", why: "shipped" };
	if (c.fulfillmentStatus === "PARTIALLY_FULFILLED")
		return { kind: "unresolved", why: "partially_fulfilled" };
	if (!WAITING.has(c.fulfillmentStatus))
		return { kind: "unresolved", why: "unknown_status" };
	if (c.liveDispatch)
		return { kind: "unresolved", why: "label_without_shipped_status" };
	return { kind: "convert" };
}

export type Resolution = { orderLineId: number; shipped: number };

export type PlannedLine = {
	orderLineId: number;
	orderId: number;
	orderName: string;
	productId: number;
	quantity: number;
	shipped: number;
	saleBatchId: string;
	parts: Part[];
};

export type UnresolvedLine = Pick<
	Candidate,
	"orderLineId" | "orderId" | "orderName" | "quantity" | "fulfillmentStatus"
> & { why: UnresolvedWhy };

export type ActivationPlan = {
	convert: PlannedLine[];
	keep: { pos: number; shipped: number };
	unresolved: UnresolvedLine[];
	fingerprint: string;
};

const live = sql<boolean>`exists (
	select 1 from ${dispatchOrders} d
	where d.order_id = ${orders.id} and d.reversed_at is null
		and (not exists (select 1 from ${shipments} s where s.dispatch_id = d.dispatch_id)
			or exists (select 1 from ${shipments} s where s.dispatch_id = d.dispatch_id and s.voided_at is null))
)`;

const undone = sql<boolean>`exists (select 1 from ${movements} u where u.reference = 'undo:' || ${orderLines.saleBatchId}::text)`;

async function candidates(db: Db, lock: boolean): Promise<Candidate[]> {
	const query = db
		.select({
			orderLineId: orderLines.id,
			orderId: orders.id,
			orderName: orders.name,
			productId: orderLines.productId,
			quantity: orderLines.quantity,
			saleBatchId: sql<string>`${orderLines.saleBatchId}`,
			cancelled: sql<boolean>`${orders.cancelledAt} is not null`,
			soldInStore: orders.soldInStore,
			fulfilledByChannel: orders.fulfilledByChannel,
			fulfillmentStatus: orders.fulfillmentStatus,
			liveDispatch: live,
		})
		.from(orderLines)
		.innerJoin(orders, eq(orders.id, orderLines.orderId))
		.where(and(isNotNull(orderLines.saleBatchId), sql`not ${undone}`))
		.orderBy(orderLines.id);
	return lock ? query.for("update", { of: orderLines }) : query;
}

async function batchParts(db: Db, batchIds: string[]) {
	const rows =
		batchIds.length === 0
			? []
			: await db
					.select({
						batchId: movements.batchId,
						productId: movements.productId,
						reason: movements.reason,
						delta: movements.delta,
					})
					.from(movements)
					.where(inArray(movements.batchId, batchIds));
	const byBatch = new Map<string, typeof rows>();
	for (const row of rows)
		byBatch.set(row.batchId, [...(byBatch.get(row.batchId) ?? []), row]);
	return byBatch;
}

function partsOfBatch(
	rows: { productId: number; reason: string; delta: number }[],
	quantity: number,
): Part[] | null {
	if (rows.length === 0 || rows.some((r) => r.reason !== "sale" || r.delta >= 0))
		return null;
	const units = new Map<number, number>();
	for (const r of rows) units.set(r.productId, (units.get(r.productId) ?? 0) - r.delta);
	const parts: Part[] = [];
	for (const [productId, n] of [...units].sort((a, b) => a[0] - b[0])) {
		if (n % quantity !== 0) return null;
		parts.push({ productId, perUnit: n / quantity });
	}
	return parts;
}

export async function planActivation(
	db: Db,
	input: { resolutions?: Resolution[]; lock?: boolean } = {},
): Promise<ActivationPlan> {
	const resolutions = new Map(
		(input.resolutions ?? []).map((r) => [r.orderLineId, r.shipped]),
	);
	const all = await candidates(db, input.lock ?? false);
	const parts = await batchParts(
		db,
		all.map((c) => c.saleBatchId),
	);
	const convert: PlannedLine[] = [];
	const unresolved: UnresolvedLine[] = [];
	const keep = { pos: 0, shipped: 0 };
	const used = new Set<number>();
	for (const c of all) {
		let decision = classifyLegacyLine(c);
		const frozen =
			c.productId === null || c.quantity <= 0
				? null
				: partsOfBatch(parts.get(c.saleBatchId) ?? [], c.quantity);
		if (decision.kind === "convert" && !frozen)
			decision = { kind: "unresolved", why: "uneven_sale_batch" };
		let shipped = 0;
		const told = resolutions.get(c.orderLineId);
		if (told !== undefined) {
			if (decision.kind !== "unresolved")
				throw new ActivationError(
					`Line ${c.orderLineId} on ${c.orderName} needs no resolution`,
				);
			if (!Number.isInteger(told) || told < 0 || told > c.quantity)
				throw new ActivationError(
					`Line ${c.orderLineId} shipped 0 to ${c.quantity}, not ${told}`,
				);
			used.add(c.orderLineId);
			if (told === c.quantity) {
				keep.shipped++;
				continue;
			}
			if (!frozen || c.cancelled || c.fulfilledByChannel)
				throw new ActivationError(
					`Line ${c.orderLineId} on ${c.orderName} can only be resolved as fully shipped`,
				);
			decision = { kind: "convert" };
			shipped = told;
		}
		if (decision.kind === "keep") {
			keep[decision.why]++;
			continue;
		}
		if (decision.kind === "unresolved" || !frozen || c.productId === null) {
			unresolved.push({
				orderLineId: c.orderLineId,
				orderId: c.orderId,
				orderName: c.orderName,
				quantity: c.quantity,
				fulfillmentStatus: c.fulfillmentStatus,
				why: decision.kind === "unresolved" ? decision.why : "uneven_sale_batch",
			});
			continue;
		}
		convert.push({
			orderLineId: c.orderLineId,
			orderId: c.orderId,
			orderName: c.orderName,
			productId: c.productId,
			quantity: c.quantity,
			shipped,
			saleBatchId: c.saleBatchId,
			parts: frozen,
		});
	}
	const stale = [...resolutions.keys()].filter((id) => !used.has(id));
	if (stale.length > 0)
		throw new ActivationError(
			`No open legacy sale on line(s) ${stale.join(", ")}`,
		);
	const fingerprint = createHash("sha256")
		.update(JSON.stringify({ convert, unresolved, keep }))
		.digest("hex");
	return { convert, keep, unresolved, fingerprint };
}

async function ledgerBalance(db: Db, productIds: number[]) {
	const rows =
		productIds.length === 0
			? []
			: await db
					.select({
						productId: stockLevels.productId,
						onHand: sql<number>`sum(${stockLevels.onHand})::int`,
					})
					.from(stockLevels)
					.innerJoin(locations, eq(locations.id, stockLevels.locationId))
					.where(
						and(
							inArray(stockLevels.productId, productIds),
							inArray(locations.kind, [...ourKinds]),
						),
					)
					.groupBy(stockLevels.productId);
	const committed = await committedUnits(db, productIds);
	return new Map(
		productIds.map((id) => [
			id,
			(rows.find((r) => r.productId === id)?.onHand ?? 0) -
				(committed.get(id) ?? 0),
		]),
	);
}

export type ActivationReport = {
	converted: number;
	partlyShipped: number;
	kept: { pos: number; shipped: number };
	fingerprint: string;
};

export async function activateCommittedMode(
	db: Db,
	input: {
		fingerprint: string;
		resolutions?: Resolution[];
		oldWorkersDrained: true;
	},
): Promise<ActivationReport> {
	if (input.oldWorkersDrained !== true)
		throw new ActivationError("Drain the old deployment's workers first");
	return db.transaction(async (tx) => {
		if ((await readQuantityMode(tx, "update")) === "committed")
			throw new ActivationError("Committed stock is already active");
		const plan = await planActivation(tx, {
			resolutions: input.resolutions,
			lock: true,
		});
		if (plan.unresolved.length > 0) throw new ActivationBlocked(plan.unresolved);
		if (plan.fingerprint !== input.fingerprint)
			throw new ActivationError(
				"The plan changed since the dry run; run it again and review",
			);
		const productIds = [
			...new Set(plan.convert.flatMap((l) => l.parts.map((p) => p.productId))),
		];
		await lockBatchProducts(
			tx,
			plan.convert.map((l) => l.saleBatchId),
			productIds,
		);
		const before = await ledgerBalance(tx, productIds);
		const report: ActivationReport = {
			converted: plan.convert.length,
			partlyShipped: plan.convert.filter((l) => l.shipped > 0).length,
			kept: plan.keep,
			fingerprint: plan.fingerprint,
		};
		await tx
			.update(quantityMode)
			.set({
				mode: "committed",
				activatedAt: sql`now()`,
				activationReport: report,
			})
			.where(and(eq(quantityMode.id, 1), eq(quantityMode.mode, "legacy")));
		for (const line of plan.convert) {
			await undoBatch(tx, line.saleBatchId);
			const cleared = await tx
				.update(orderLines)
				.set({ saleBatchId: null })
				.where(
					and(
						eq(orderLines.id, line.orderLineId),
						eq(orderLines.saleBatchId, line.saleBatchId),
					),
				)
				.returning({ id: orderLines.id });
			if (cleared.length !== 1)
				throw new ActivationError(`Line ${line.orderLineId} changed mid-activation`);
			await settleLine(tx, {
				orderLineId: line.orderLineId,
				orderId: line.orderId,
				productId: line.productId,
				target: line.quantity,
				freshParts: async () => line.parts,
				legacySaleBatchId: line.saleBatchId,
			});
			if (line.shipped > 0)
				await consumeCommitments(tx, {
					orderId: line.orderId,
					lines: [{ orderLineId: line.orderLineId, quantity: line.shipped }],
					fulfillmentKey: `activation:${line.orderLineId}`,
				});
		}
		const after = await ledgerBalance(tx, productIds);
		const moved = productIds.filter((id) => before.get(id) !== after.get(id));
		if (moved.length > 0)
			throw new ActivationError(
				`Activation would change sellable stock of product(s) ${moved.join(", ")}`,
			);
		const histories = await lineHistories(
			tx,
			plan.convert.map((l) => l.orderLineId),
		);
		const wrong = plan.convert.filter(
			(l) => histories.get(l.orderLineId)?.remaining !== l.quantity - l.shipped,
		);
		if (wrong.length > 0)
			throw new ActivationError(
				`Reservations came out wrong on line(s) ${wrong.map((l) => l.orderLineId).join(", ")}`,
			);
		const drift = await committedDrift(tx);
		if (drift.length > 0)
			throw new ActivationError(
				`Committed totals drifted on product(s) ${drift.map((d) => d.productId).join(", ")}`,
			);
		return report;
	});
}
