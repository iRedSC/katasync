import { and, asc, eq, inArray, max, sql } from "drizzle-orm";
import type { Db } from "#/db/client";
import { repairs } from "#/db/repair-schema";
import type { RepairStatus } from "./status";

// Each board column is a queue, top first. A repair's place is a number
// (repairs.position): moved in, it goes after the last; dropped between
// two, halfway between them. When halves run too fine to tell apart, the
// column is numbered afresh.

// The statuses sharing a column: the last holds both ways of being done.
const columnOf = (status: RepairStatus): RepairStatus[] =>
	status === "picked_up" || status === "refurbished"
		? ["picked_up", "refurbished"]
		: [status];

// The board's order, held until the transaction ends. Placing a repair
// locks its whole column, so a move takes this before locking the repair
// it moves: otherwise two moves in one column each hold a card the other's
// column lock waits for. Only holdQueue makes one, and placeIn needs one.
declare const queueHeld: unique symbol;
export type QueueHeld = { readonly [queueHeld]: true };

export async function holdQueue(tx: Db): Promise<QueueHeld> {
	await tx.execute(
		sql`select pg_advisory_xact_lock(hashtext('katasync:repair-queue'))`,
	);
	return {} as QueueHeld;
}

// Too close to halve again without the two coming out equal.
const FINEST = 1e-6;

// Where a repair goes last in a column.
export async function lastIn(tx: Db, status: RepairStatus, except: number) {
	const [row] = await tx
		.select({ last: max(repairs.position) })
		.from(repairs)
		.where(
			and(
				inArray(repairs.status, columnOf(status)),
				sql`${repairs.id} <> ${except}`,
			),
		);
	return (row?.last ?? 0) + 1;
}

// Puts a repair just above `before` in its column, or last when null (or
// when `before` is no longer in that column). Run holding the queue, then
// the repair.
export async function placeIn(
	tx: Db,
	_queue: QueueHeld,
	id: number,
	status: RepairStatus,
	before: number | null,
) {
	const column = await tx
		.select({ id: repairs.id, position: repairs.position })
		.from(repairs)
		.where(
			and(
				inArray(repairs.status, columnOf(status)),
				sql`${repairs.id} <> ${id}`,
			),
		)
		.orderBy(asc(repairs.position), asc(repairs.id))
		.for("update");
	const at = before === null ? -1 : column.findIndex((r) => r.id === before);
	let position: number;
	if (at === -1) position = (column.at(-1)?.position ?? 0) + 1;
	else {
		const below = column[at].position;
		const above = at === 0 ? below - 1 : column[at - 1].position;
		if (below - above >= FINEST) position = (above + below) / 2;
		else {
			// Numbered afresh, leaving a whole step where it goes.
			for (const [i, r] of column.entries())
				await tx
					.update(repairs)
					.set({ position: i < at ? i : i + 1 })
					.where(eq(repairs.id, r.id));
			position = at;
		}
	}
	await tx.update(repairs).set({ position }).where(eq(repairs.id, id));
}
