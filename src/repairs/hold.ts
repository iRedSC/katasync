import type { Db } from "#/db/client";
import {
	type Locked,
	lockRepair,
	markPaid,
	PaidInShopify,
	RepairError,
	syncDraft,
} from "./draft-sync";
import { holdQueue, type QueueHeld } from "./queue";
import { isOnBoard } from "./status";

// Changing a repair: holding its row while the change runs, and writing its
// draft order before committing (src/repairs/draft-sync.ts).

type Options = { sync?: boolean; open?: boolean };

// Runs `change` holding the repair, then writes its draft order. A draft
// paid meanwhile moves the repair to Picked up and refuses the change.
// With `queue`, it holds the board's order first, to move the repair.
export async function withRepair<T>(
	db: Db,
	id: number,
	change: (tx: Db, r: Locked, queue: QueueHeld) => Promise<T>,
	options: Options & { queue: true },
): Promise<T>;
export async function withRepair<T>(
	db: Db,
	id: number,
	change: (tx: Db, r: Locked) => Promise<T>,
	options?: Options,
): Promise<T>;
export async function withRepair<T>(
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
export async function withCharges<T>(
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
