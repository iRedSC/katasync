import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { sendDraftInvoice } from "#/channels/shopify/draft-orders";
import type { Db } from "#/db/client";
import { people, repairLabor, repairParts, repairs } from "#/db/repair-schema";
import { products } from "#/db/schema";
import { rehold } from "./bench";
import {
	type Locked,
	lockRepair,
	markPaid,
	PaidInShopify,
	RepairError,
	syncDraft,
} from "./draft-sync";
import { LABOR_STEP } from "./labor";
import { holdQueue, lastIn, placeIn, type QueueHeld } from "./queue";
import {
	boardStatuses,
	isOnBoard,
	type RepairStatus,
	refuseMove,
} from "./status";

// What staff do to a repair. Each change to a customer's that touches what
// it charges writes the draft order too (src/repairs/draft-sync.ts); a
// bench job (src/repairs/bench.ts) has none.

export { RepairError };

export type CustomerRef = {
	id: string;
	name: string;
	phone: string | null;
	email: string | null;
};

const clean = (s: string | null | undefined) => s?.trim() || null;

async function technician(db: Db, id: number | null) {
	if (id === null) return null;
	const [p] = await db
		.select({ id: people.id })
		.from(people)
		.where(and(eq(people.id, id), isNull(people.archivedAt)));
	if (!p) throw new RepairError("That person isn't in Settings any more");
	return p.id;
}

// The catalog product a tool is, checked to be one.
async function toolProduct(db: Db, id: number | null) {
	if (id === null) return null;
	const [p] = await db
		.select({ id: products.id })
		.from(products)
		.where(eq(products.id, id));
	if (!p) throw new RepairError("That product isn't in the catalog");
	return p.id;
}

// A customer was edited in Shopify: their open repairs show the new name
// and phone.
export async function customerChanged(db: Db, c: CustomerRef) {
	await db
		.update(repairs)
		.set({
			customerName: c.name,
			customerPhone: c.phone,
			customerEmail: c.email,
		})
		.where(
			and(
				eq(repairs.customerId, c.id),
				inArray(repairs.status, [...boardStatuses]),
			),
		);
}

export async function createRepair(
	db: Db,
	input: {
		customer: CustomerRef;
		tool: string;
		// The catalog product it is, when picked as one.
		productId?: number | null;
		serial?: string | null;
		problem?: string;
		technicianId?: number | null;
	},
) {
	const tool = input.tool.trim();
	if (!tool) throw new RepairError("Say what the tool is");
	const [made] = await db
		.insert(repairs)
		.values({
			customerId: input.customer.id,
			customerName: input.customer.name,
			customerPhone: input.customer.phone,
			customerEmail: input.customer.email,
			tool,
			productId: await toolProduct(db, input.productId ?? null),
			serial: clean(input.serial),
			problem: input.problem?.trim() ?? "",
			technicianId: await technician(db, input.technicianId ?? null),
		})
		.returning({ id: repairs.id });
	return made.id;
}

type Options = { sync?: boolean; open?: boolean };

// Runs `change` holding the repair, then writes its draft order. A draft
// paid meanwhile moves the repair to Picked up and refuses the change.
// With `queue`, it holds the board's order first, to move the repair.
async function withRepair<T>(
	db: Db,
	id: number,
	change: (tx: Db, r: Locked, queue: QueueHeld) => Promise<T>,
	options: Options & { queue: true },
): Promise<T>;
async function withRepair<T>(
	db: Db,
	id: number,
	change: (tx: Db, r: Locked) => Promise<T>,
	options?: Options,
): Promise<T>;
async function withRepair<T>(
	db: Db,
	id: number,
	change: (tx: Db, r: Locked, queue: QueueHeld) => Promise<T>,
	{ sync = true, open = true, queue }: Options & { queue?: true } = {},
): Promise<T> {
	try {
		return await db.transaction(async (tx) => {
			const held = queue ? await holdQueue(tx) : undefined;
			const r = await lockRepair(tx, id);
			if (open && !isOnBoard(r.status))
				throw new RepairError(
					`R${id} is ${r.status === "cancelled" ? "cancelled" : "picked up"}; move it back to the board to change it`,
				);
			// Without `queue`, the overloads give a change that takes none.
			const result = await change(tx, r, held as QueueHeld);
			if (sync && r.draftOrderId !== null)
				await syncDraft(tx, await lockRepair(tx, id));
			return result;
		});
	} catch (error) {
		if (error instanceof PaidInShopify) {
			await markPaid(db, id, error.order);
			throw new RepairError(
				`R${id} was already paid in Shopify as ${error.order.name}`,
			);
		}
		throw error;
	}
}

// Writes the draft even when the repair has none yet: its charges changed.
async function withCharges<T>(
	db: Db,
	id: number,
	change: (tx: Db, r: Locked) => Promise<T>,
) {
	return withRepair(
		db,
		id,
		async (tx, r) => {
			const result = await change(tx, r);
			if (r.kind === "customer") await syncDraft(tx, await lockRepair(tx, id));
			return result;
		},
		{ sync: false },
	);
}

export type RepairEdit = {
	tool?: string;
	// The catalog product the tool is, or null for one typed out. Goes with
	// the tool: naming it anew without one makes it typed out.
	productId?: number | null;
	serial?: string | null;
	problem?: string;
	notes?: string;
	technicianId?: number | null;
	customer?: CustomerRef;
};

export async function editRepair(db: Db, id: number, edit: RepairEdit) {
	const tool = edit.tool?.trim();
	if (edit.tool !== undefined && !tool)
		throw new RepairError("Say what the tool is");
	// Notes and who has it don't show on the draft.
	const onDraft =
		edit.tool !== undefined ||
		edit.serial !== undefined ||
		edit.problem !== undefined ||
		edit.customer !== undefined;
	await withRepair(
		db,
		id,
		async (tx, r) => {
			if (edit.customer && r.kind === "bench")
				throw new RepairError(`R${id} is ours; it has no customer`);
			if (edit.productId !== undefined && tool === undefined)
				throw new RepairError("Name the tool along with its product");
			// A bench job is always the product it came in as.
			if (
				r.kind === "bench" &&
				edit.productId !== undefined &&
				edit.productId !== r.productId
			)
				throw new RepairError(
					`R${id} is ours; it stays the tool it came in as`,
				);
			const productId =
				r.kind === "customer" && tool !== undefined
					? await toolProduct(tx, edit.productId ?? null)
					: undefined;
			await tx
				.update(repairs)
				.set({
					...(tool !== undefined && { tool }),
					...(productId !== undefined && { productId }),
					...(edit.serial !== undefined && { serial: clean(edit.serial) }),
					...(edit.problem !== undefined && { problem: edit.problem.trim() }),
					...(edit.notes !== undefined && { notes: edit.notes }),
					...(edit.technicianId !== undefined && {
						technicianId: await technician(tx, edit.technicianId),
					}),
					...(edit.customer && {
						customerId: edit.customer.id,
						customerName: edit.customer.name,
						customerPhone: edit.customer.phone,
						customerEmail: edit.customer.email,
					}),
				})
				.where(eq(repairs.id, id));
		},
		// Who has it and its notes can change after pickup too.
		{ sync: onDraft, open: onDraft },
	);
}

// Moves a repair to another column, or off the board, going last in it.
// Cancelling takes its charges off the draft order; restoring puts them
// back. With `before`, it goes just above that repair instead, which also
// reorders a column (src/repairs/queue.ts); null puts it last.
export async function moveRepair(
	db: Db,
	id: number,
	to: RepairStatus,
	before?: number | null,
) {
	return withRepair(
		db,
		id,
		async (tx, r, queue) => {
			const why = refuseMove(
				{
					status: r.status,
					bench: r.kind === "bench",
					hasDraft: r.draftOrderId !== null,
					paid: r.orderId !== null,
				},
				to,
			);
			if (why) throw new RepairError(why);
			if (r.status === to) {
				if (before !== undefined) await placeIn(tx, queue, id, to, before);
				return { from: r.status };
			}
			// Off the draft first: a closed repair can't hold one.
			if (to === "cancelled" && r.kind === "customer")
				await syncDraft(tx, r, { charges: false });
			// Back from cancelled, a bench job takes its returned unit again.
			if (r.status === "cancelled" && r.kind === "bench") await rehold(tx, r);
			const moved = await tx
				.update(repairs)
				.set({
					status: to,
					statusChangedAt: sql`now()`,
					position: await lastIn(tx, to, id),
				})
				.where(and(eq(repairs.id, id), eq(repairs.status, r.status)))
				.returning({ id: repairs.id });
			if (moved.length === 0)
				throw new RepairError(`R${id} just changed; try again`);
			if (before != null) await placeIn(tx, queue, id, to, before);
			if (r.status === "cancelled" && r.kind === "customer")
				await syncDraft(tx, { ...r, status: to });
			return { from: r.status };
		},
		{ sync: false, open: false, queue: true },
	);
}

export async function addLabor(db: Db, id: number, minutes: number, note = "") {
	checkMinutes(minutes);
	return withCharges(db, id, async (tx) => {
		const [row] = await tx
			.insert(repairLabor)
			.values({ repairId: id, minutes, note: note.trim() })
			.returning({ id: repairLabor.id });
		return row.id;
	});
}

export async function editLabor(
	db: Db,
	id: number,
	laborId: number,
	edit: { minutes?: number; note?: string },
) {
	if (edit.minutes !== undefined) checkMinutes(edit.minutes);
	return withCharges(db, id, async (tx) => {
		const done = await tx
			.update(repairLabor)
			.set({
				...(edit.minutes !== undefined && { minutes: edit.minutes }),
				...(edit.note !== undefined && { note: edit.note.trim() }),
			})
			.where(and(eq(repairLabor.id, laborId), eq(repairLabor.repairId, id)))
			.returning({ id: repairLabor.id });
		if (done.length === 0)
			throw new RepairError("That time isn't on this repair");
	});
}

export async function removeLabor(db: Db, id: number, laborId: number) {
	return withCharges(db, id, async (tx) => {
		const [gone] = await tx
			.delete(repairLabor)
			.where(and(eq(repairLabor.id, laborId), eq(repairLabor.repairId, id)))
			.returning({ minutes: repairLabor.minutes, note: repairLabor.note });
		if (!gone) throw new RepairError("That time isn't on this repair");
		return gone;
	});
}

function checkMinutes(minutes: number) {
	if (
		!Number.isInteger(minutes) ||
		minutes <= 0 ||
		minutes % LABOR_STEP !== 0 ||
		minutes > 6000
	)
		throw new RepairError(`Time goes in ${LABOR_STEP}-minute steps`);
}

// Sets how many of a part went into the tool; 0 takes it off.
export async function setPart(
	db: Db,
	id: number,
	productId: number,
	quantity: number,
) {
	if (!Number.isInteger(quantity) || quantity < 0 || quantity > 999)
		throw new RepairError("Quantity must be 0 to 999");
	return withCharges(db, id, async (tx) => {
		const [product] = await tx
			.select({ kind: products.kind })
			.from(products)
			.where(eq(products.id, productId));
		if (!product) throw new RepairError("No such product");
		if (quantity === 0) {
			await tx
				.delete(repairParts)
				.where(
					and(
						eq(repairParts.repairId, id),
						eq(repairParts.productId, productId),
					),
				);
			return;
		}
		await tx
			.insert(repairParts)
			.values({ repairId: id, productId, quantity })
			.onConflictDoUpdate({
				target: [repairParts.repairId, repairParts.productId],
				set: { quantity },
			});
	});
}

// Emails the customer Shopify's invoice, with its pay link.
export async function emailInvoice(db: Db, id: number) {
	const [r] = await db.select().from(repairs).where(eq(repairs.id, id));
	if (!r) throw new RepairError(`No repair R${id}`);
	if (!r.draftOrderId) throw new RepairError("Nothing to charge yet");
	if (!r.customerEmail) throw new RepairError("The customer has no email");
	await sendDraftInvoice(r.draftOrderId);
	return r.customerEmail;
}
