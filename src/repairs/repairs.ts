import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { sendDraftInvoice } from "#/channels/shopify/draft-orders";
import type { Db } from "#/db/client";
import {
	people,
	repairLabor,
	repairParts,
	repairs,
	repairTools,
} from "#/db/repair-schema";
import { products } from "#/db/schema";
import { rehold } from "./bench";
import { RepairError, syncDraft } from "./draft-sync";
import { withCharges, withRepair } from "./hold";
import { LABOR_STEP } from "./labor";
import { lastIn, placeIn } from "./queue";
import { boardStatuses, type RepairStatus, refuseMove } from "./status";
import { checkTool, type ToolFields, toolValues } from "./tools";

// What staff do to a repair. Each change to a customer's that touches what
// it charges writes the draft order too (src/repairs/draft-sync.ts); a
// bench job (src/repairs/bench.ts) has none. Its tools are added and
// changed in src/repairs/tools.ts.

export { RepairError };

export type CustomerRef = {
	id: string;
	name: string;
	phone: string | null;
	email: string | null;
};

async function technician(db: Db, id: number | null) {
	if (id === null) return null;
	const [p] = await db
		.select({ id: people.id })
		.from(people)
		.where(and(eq(people.id, id), isNull(people.archivedAt)));
	if (!p) throw new RepairError("That person isn't in Settings any more");
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
		// What came in, at least one.
		tools: [ToolFields, ...ToolFields[]];
		technicianId?: number | null;
	},
) {
	return db.transaction(async (tx) => {
		const tools = [];
		for (const t of input.tools) tools.push(await toolValues(tx, t));
		const [made] = await tx
			.insert(repairs)
			.values({
				customerId: input.customer.id,
				customerName: input.customer.name,
				customerPhone: input.customer.phone,
				customerEmail: input.customer.email,
				technicianId: await technician(tx, input.technicianId ?? null),
			})
			.returning({ id: repairs.id });
		await tx
			.insert(repairTools)
			.values(tools.map((t) => ({ ...t, repairId: made.id })));
		return made.id;
	});
}

export type RepairEdit = {
	notes?: string;
	technicianId?: number | null;
	customer?: CustomerRef;
};

export async function editRepair(db: Db, id: number, edit: RepairEdit) {
	// Notes and who has it don't show on the draft.
	const onDraft = edit.customer !== undefined;
	await withRepair(
		db,
		id,
		async (tx, r) => {
			if (edit.customer && r.kind === "bench")
				throw new RepairError(`R${id} is ours; it has no customer`);
			await tx
				.update(repairs)
				.set({
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

// Time on one of the repair's tools, or on the order as a whole (null).
export async function addLabor(
	db: Db,
	id: number,
	labor: { toolId: number | null; minutes: number; note?: string },
) {
	checkMinutes(labor.minutes);
	return withCharges(db, id, async (tx) => {
		await checkTool(tx, id, labor.toolId);
		const [row] = await tx
			.insert(repairLabor)
			.values({
				repairId: id,
				toolId: labor.toolId,
				minutes: labor.minutes,
				note: labor.note?.trim() ?? "",
			})
			.returning({ id: repairLabor.id });
		return row.id;
	});
}

export async function editLabor(
	db: Db,
	id: number,
	laborId: number,
	edit: { minutes?: number; note?: string; toolId?: number | null },
) {
	if (edit.minutes !== undefined) checkMinutes(edit.minutes);
	return withCharges(db, id, async (tx) => {
		if (edit.toolId !== undefined) await checkTool(tx, id, edit.toolId);
		const done = await tx
			.update(repairLabor)
			.set({
				...(edit.minutes !== undefined && { minutes: edit.minutes }),
				...(edit.note !== undefined && { note: edit.note.trim() }),
				...(edit.toolId !== undefined && { toolId: edit.toolId }),
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
			.returning({
				toolId: repairLabor.toolId,
				minutes: repairLabor.minutes,
				note: repairLabor.note,
			});
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

// Sets how many of a part went into one of the repair's tools, or onto the
// order as a whole (null); 0 takes it off.
export async function setPart(
	db: Db,
	id: number,
	part: { toolId: number | null; productId: number; quantity: number },
) {
	const { toolId, productId, quantity } = part;
	if (!Number.isInteger(quantity) || quantity < 0 || quantity > 999)
		throw new RepairError("Quantity must be 0 to 999");
	return withCharges(db, id, async (tx) => {
		await checkTool(tx, id, toolId);
		const [product] = await tx
			.select({ kind: products.kind })
			.from(products)
			.where(eq(products.id, productId));
		if (!product) throw new RepairError("No such product");
		const here = and(
			eq(repairParts.repairId, id),
			toolId === null
				? isNull(repairParts.toolId)
				: eq(repairParts.toolId, toolId),
			eq(repairParts.productId, productId),
		);
		if (quantity === 0) {
			await tx.delete(repairParts).where(here);
			return;
		}
		await tx
			.insert(repairParts)
			.values({ repairId: id, toolId, productId, quantity })
			.onConflictDoUpdate({
				target: [
					repairParts.repairId,
					repairParts.toolId,
					repairParts.productId,
				],
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
