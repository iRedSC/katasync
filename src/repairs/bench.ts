import { and, eq, inArray, sql } from "drizzle-orm";
import { stockLocations } from "#/channels/stores";
import type { Db } from "#/db/client";
import { people, repairParts, repairs } from "#/db/repair-schema";
import {
	orderLines,
	orderReturns,
	orders,
	products,
	stockLevels,
} from "#/db/schema";
import { readQuantityMode } from "#/inventory/commitments";
import { returnSaleOf } from "#/inventory/commitments-consume";
import { brokenPromises } from "#/inventory/commitments-shelves";
import { postMovements } from "#/inventory/ledger";
import { batchProductIds, lockStockProducts } from "#/inventory/ledger/post";
import {
	makeRefurb,
	originalProduct,
	type RefurbDetails,
} from "#/orders/refurbish";
import { returnQuantity } from "#/orders/return-stock";
import { receiveReturn } from "#/orders/returns";
import { onBench } from "./bench-holds";
import { lockRepair, RepairError } from "./draft-sync";
import { holdQueue, lastIn } from "./queue";
import { isOnBoard, statusNames } from "./status";

// Bench jobs: our own tools, fixed up at the bench to sell as refurbs. One
// comes from a returned line, holding one of its units (not received yet,
// and not due: src/repairs/bench-holds.ts), or from the board, for a tool
// bought in. Listing it makes the refurb (src/orders/refurbish.ts), or adds
// to one of the same condition, and takes its parts off the shelf; the
// refurb costs what the unit did plus its parts. Its labor is only time.

// What listing makes: a new refurb, or one more of an existing one.
export type ListAs =
	| ({ kind: "new" } & RefurbDetails)
	| { kind: "add"; productId: number };

// Where bench work happens: where walk-ins buy, as a customer repair's parts
// come off with its POS sale, else the store, else the warehouse.
async function benchShelf(db: Db) {
	const at = await stockLocations(db);
	const shelf = at.pos ?? at.store ?? at.shipping;
	if (shelf === null)
		throw new RepairError("No location to take bench parts from");
	return shelf;
}

// How many of a returned line's units can still go on the bench. Run
// holding the order, as receiving does, so the two can't both take a unit.
async function roomOnLine(tx: Db, orderId: number, lineId: number) {
	const [order] = await tx
		.select({ fbc: orders.fulfilledByChannel, name: orders.name })
		.from(orders)
		.where(eq(orders.id, orderId))
		.for("update");
	if (!order) throw new RepairError("No such order");
	if (order.fbc)
		throw new RepairError(`${order.name} was fulfilled by the channel`);
	const [line] = await tx
		.select({
			productId: orderLines.productId,
			name: sql<string>`coalesce(${orderLines.sku}, ${orderLines.title})`,
			room: sql<number>`(${returnQuantity} - coalesce((
				select sum(r.quantity) from ${orderReturns} r
				where r.order_line_id = "order_lines"."id"
			), 0) - ${onBench()})::int`,
		})
		.from(orderLines)
		.where(and(eq(orderLines.id, lineId), eq(orderLines.orderId, orderId)));
	if (!line) throw new RepairError("That line isn't on the order");
	return { ...line, order: order.name };
}

// Puts a returned line's units on the bench, a job each, or a tool bought
// in. Returns the new jobs' numbers.
export async function startBench(
	db: Db,
	input: (
		| { orderId: number; lineId: number; quantity: number }
		| { productId: number }
	) & {
		tool?: string;
		serial?: string | null;
		problem?: string;
		technicianId?: number | null;
	},
): Promise<number[]> {
	return db.transaction(async (tx) => {
		let productId: number;
		let count = 1;
		let returnLineId: number | null = null;
		if ("lineId" in input) {
			const line = await roomOnLine(tx, input.orderId, input.lineId);
			if (line.productId === null)
				throw new RepairError(
					`Match ${line.name} to a product before it goes on the bench`,
				);
			if (!Number.isInteger(input.quantity) || input.quantity < 1)
				throw new RepairError("Put at least one on the bench");
			if (input.quantity > line.room)
				throw new RepairError(
					line.room === 0
						? `${line.name} is already back`
						: `Only ${line.room} of ${line.name} can still come back`,
				);
			productId = line.productId;
			count = input.quantity;
			returnLineId = input.lineId;
		} else productId = input.productId;
		const [product] = await tx
			.select({ name: products.name, kind: products.kind })
			.from(products)
			.where(eq(products.id, productId));
		if (!product) throw new RepairError("No such product");
		if (product.kind === "bundle")
			throw new RepairError("A set can't be refurbished; bench its tools");
		if (input.technicianId != null) {
			const [p] = await tx
				.select({ id: people.id })
				.from(people)
				.where(
					and(eq(people.id, input.technicianId), sql`archived_at is null`),
				);
			if (!p) throw new RepairError("That person isn't in Settings any more");
		}
		const tool = input.tool?.trim() || product.name;
		const made = await tx
			.insert(repairs)
			.values(
				Array.from({ length: count }, () => ({
					kind: "bench" as const,
					productId,
					returnLineId,
					tool,
					serial: input.serial?.trim() || null,
					problem: input.problem?.trim() ?? "",
					technicianId: input.technicianId ?? null,
				})),
			)
			.returning({ id: repairs.id });
		return made.map((m) => m.id);
	});
}

// A cancelled bench job coming back to the board takes its unit back, if
// it's still to come in: run by moveRepair holding the job.
export async function rehold(tx: Db, r: { returnLineId: number | null }) {
	if (r.returnLineId === null) return;
	const [line] = await tx
		.select({ orderId: orderLines.orderId })
		.from(orderLines)
		.where(eq(orderLines.id, r.returnLineId));
	const { room, name } = await roomOnLine(tx, line.orderId, r.returnLineId);
	if (room < 1)
		throw new RepairError(`${name} was received since; it can't go back`);
}

type Locked = Awaited<ReturnType<typeof lockStockProducts>>;

// Locks everything listing a job writes before writing any of it: its
// returned line's order first, as receiving a return and shipping do, then
// every product it touches (its parts, the tool, what the line sold as, the
// refurb it adds to) lowest id first, as stock writes do. Taken as each
// write comes, they'd deadlock with those. Run holding the job, so its
// parts can't change meanwhile.
async function lockListing(
	tx: Db,
	r: { id: number; productId: number },
	line: {
		orderId: number;
		lineId: number;
		productId: number | null;
		saleBatchId: string | null;
	} | null,
	into: number | null,
) {
	if (line)
		await tx
			.select({ id: orders.id })
			.from(orders)
			.where(eq(orders.id, line.orderId))
			.for("update");
	const parts = await tx
		.select({ productId: repairParts.productId })
		.from(repairParts)
		.where(eq(repairParts.repairId, r.id));
	const sale = line
		? (line.saleBatchId ?? (await returnSaleOf(tx, line.lineId))?.batchId)
		: null;
	return lockStockProducts(tx, [
		r.productId,
		...parts.map((p) => p.productId),
		...(sale ? await batchProductIds(tx, [sale]) : []),
		...(line?.productId == null ? [] : [line.productId]),
		...(into === null ? [] : [into]),
	]);
}

// Takes a job's parts off the bench shelf, refusing what isn't there (or,
// with stock committed, is promised to an order). Their cost is each one's
// average now; null when any has none, so the refurb's stays unknown too.
// Run holding the parts (lockListing).
async function takeParts(tx: Db, repairId: number, locked: Locked) {
	const parts = await tx
		.select({
			productId: repairParts.productId,
			quantity: repairParts.quantity,
			sku: products.sku,
		})
		.from(repairParts)
		.innerJoin(products, eq(products.id, repairParts.productId))
		.where(eq(repairParts.repairId, repairId));
	if (parts.length === 0) return { batchId: null, cost: 0 };
	const ids = parts.map((p) => p.productId);
	const mode = await readQuantityMode(tx);
	const shelf = await benchShelf(tx);
	const levels = await tx
		.select({ productId: stockLevels.productId, here: stockLevels.onHand })
		.from(stockLevels)
		.where(
			and(
				inArray(stockLevels.productId, ids),
				eq(stockLevels.locationId, shelf),
			),
		);
	const promised = await brokenPromises(
		tx,
		mode,
		parts.map((p) => ({ ...p, locationId: shelf })),
	);
	let cost: number | null = 0;
	for (const p of parts) {
		const product = locked.find((l) => l.id === p.productId);
		if (!product) throw new RepairError(`${p.sku} changed; try again`);
		if (product.kind === "bundle")
			throw new RepairError(`${p.sku} is a set; put its parts on instead`);
		const here = levels.find((l) => l.productId === p.productId)?.here ?? 0;
		if (here < p.quantity)
			throw new RepairError(`Only ${here} of ${p.sku} on the bench's shelf`);
		if (promised.includes(p.productId))
			throw new RepairError(`${p.sku} is promised to orders`);
		cost =
			cost === null || product.unitCost == null
				? null
				: cost + product.unitCost * p.quantity;
	}
	const { batchId } = await postMovements(tx, {
		lines: parts.map((p) => ({
			productId: p.productId,
			locationId: shelf,
			delta: -p.quantity,
			reason: "adjustment" as const,
		})),
		reference: `bench:${repairId}`,
		note: `Parts for R${repairId}`,
	});
	return { batchId, cost };
}

const round4 = (n: number) => Math.round(n * 10_000) / 10_000;

// Lists a bench job: makes its refurb (or adds to one), puts its unit on
// the shelf as that, takes its parts, and closes it. All or nothing; a
// Shopify draft made for it is deleted again if anything after fails.
export async function listBench(db: Db, id: number, as: ListAs) {
	return db.transaction(async (tx) => {
		// The queue before the repair, as moves take them: reopening another
		// job on this order holds the queue and the order, then locks this
		// job's column, so holding this job first would deadlock with it.
		await holdQueue(tx);
		await readQuantityMode(tx);
		const r = await lockRepair(tx, id);
		if (r.kind !== "bench" || r.productId === null)
			throw new RepairError(`R${id} is a customer's repair`);
		if (!isOnBoard(r.status))
			throw new RepairError(
				`R${id} is ${statusNames[r.status].toLowerCase()}; put it back on the board first`,
			);
		const original = await originalProduct(tx, r.productId);
		const [line] = r.returnLineId
			? await tx
					.select({
						orderId: orderLines.orderId,
						lineId: orderLines.id,
						productId: orderLines.productId,
						saleBatchId: orderLines.saleBatchId,
						cost: orderLines.unitCost,
					})
					.from(orderLines)
					.where(eq(orderLines.id, r.returnLineId))
			: [null];
		const locked = await lockListing(
			tx,
			{ id, productId: r.productId },
			line,
			as.kind === "add" ? as.productId : null,
		);
		const parts = await takeParts(tx, id, locked);
		const base = (line ? line.cost : null) ?? original.product.unitCost;
		const unitCost =
			base === null || parts.cost === null ? null : round4(base + parts.cost);

		const receive = async (refurbId: number) => {
			if (line && r.returnLineId !== null) {
				await receiveReturn(
					tx,
					{
						orderId: line.orderId,
						lines: [{ lineId: r.returnLineId, quantity: 1 }],
						outcome: { refurbishInto: refurbId },
					},
					{ repairId: id, unitCost },
				);
			} else {
				await postMovements(tx, {
					lines: [
						{
							productId: refurbId,
							locationId: await benchShelf(tx),
							delta: 1,
							reason: "receipt",
						},
					],
					reference: `bench:${id}`,
					note: `R${id}, listed`,
					costs: [
						{ productId: refurbId, kind: "receipt", units: 1, value: unitCost },
					],
				});
			}
			const closed = await tx
				.update(repairs)
				.set({
					status: "refurbished",
					refurbProductId: refurbId,
					partsBatchId: parts.batchId,
					statusChangedAt: sql`now()`,
					position: await lastIn(tx, "refurbished", id),
				})
				.where(and(eq(repairs.id, id), eq(repairs.status, r.status)))
				.returning({ id: repairs.id });
			if (closed.length === 0)
				throw new RepairError(`R${id} just changed; try again`);
		};

		if (as.kind === "new") {
			const made = await makeRefurb(
				tx,
				{ original, details: as, quantity: 1, unitCost },
				receive,
			);
			return {
				sku: made.sku,
				productId: made.productId,
				shopifyUrl: made.shopifyUrl,
			};
		}
		const into = locked.find((p) => p.id === as.productId);
		if (!into || into.refurbishedFromId !== r.productId)
			throw new RepairError(
				`That refurb isn't made from ${original.product.sku}`,
			);
		if (into.archivedAt)
			throw new RepairError(`${into.sku} is archived; make a new refurb`);
		await receive(as.productId);
		return { sku: into.sku, productId: as.productId, shopifyUrl: null };
	});
}
export { RepairError };
