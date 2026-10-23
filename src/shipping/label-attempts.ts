import { and, count, eq, inArray, isNull, sql } from "drizzle-orm";
import type { Db } from "#/db/client";
import {
	dispatches,
	dispatchOrders,
	labelAttempts,
	orders,
	type PreparedBox,
	shipments,
} from "#/db/schema";
import { lockOnOwnConnection, type OrderLocker, ordersOf } from "./dispatch";
import {
	type AttemptState,
	assertTransition,
	fromStates,
	type Label,
	type Lookup,
	settled,
} from "./label-attempt-state";
import { findLabel } from "./shippo";
import { tiktokFindLabel, tiktokOrderId } from "./tiktok";

// Saving each paid label purchase before the provider is asked, settling it
// from the answer, and settling the unanswered ones later by asking the
// provider what happened (see label_attempts in schema.ts).

export type Attempt = typeof labelAttempts.$inferSelect;
type Shipment = typeof shipments.$inferSelect;

export async function beginAttempt(
	db: Db,
	input: {
		dispatchId: number;
		boxIndex: number;
		provider: Attempt["provider"];
		rateId: string;
		unitIds: string[] | null;
		box: PreparedBox;
	},
) {
	const [attempt] = await db
		.insert(labelAttempts)
		.values({ id: crypto.randomUUID(), ...input, state: "pending" })
		.returning();
	return attempt;
}

// Moves an attempt to failed or unknown, only from a state that may; a stale
// or repeated move finds nothing to change and throws.
export async function settleWithout(
	db: Db,
	attempt: Pick<Attempt, "id" | "state">,
	to: "failed" | "unknown",
	fields: { error: string; lastLookup?: Attempt["lastLookup"] },
) {
	assertTransition(attempt.state, to);
	const now = new Date();
	const [moved] = await db
		.update(labelAttempts)
		.set({
			state: to,
			error: fields.error,
			lastLookup: fields.lastLookup ?? null,
			checkedAt: fields.lastLookup ? now : null,
			settledAt: to === "failed" ? now : null,
		})
		.where(guard(attempt.id, to))
		.returning();
	if (!moved) throw new Error("This label purchase was already settled");
	return moved;
}

const guard = (id: string, to: AttemptState) =>
	and(eq(labelAttempts.id, id), inArray(labelAttempts.state, fromStates(to)));

// Records a bought label and settles its attempt, together, and marks the
// dispatch bought if that was its last box: a box is never saved without
// its attempt saying so, and a crash can't leave every box bought but the
// dispatch not.
export async function recordBought(
	db: Db,
	attempt: Pick<Attempt, "id" | "state" | "dispatchId" | "box">,
	label: Label,
	overrides: Partial<PreparedBox> = {},
): Promise<{ shipment: Shipment; completed: boolean }> {
	assertTransition(attempt.state, "succeeded");
	return db.transaction(async (tx) => {
		const [saved] = await tx
			.insert(shipments)
			.values({
				...attempt.box,
				...overrides,
				dispatchId: attempt.dispatchId,
				externalId: label.externalId,
				trackingNumber: label.trackingNumber,
				trackingUrl: label.trackingUrl,
				labelUrl: label.labelUrl,
				...(label.voided && {
					voidedAt: new Date(),
					refundStatus: label.voided.refundStatus,
				}),
			})
			.returning();
		const [moved] = await tx
			.update(labelAttempts)
			.set({
				state: "succeeded",
				shipmentId: saved.id,
				error: null,
				lastLookup: null,
				settledAt: new Date(),
			})
			.where(guard(attempt.id, "succeeded"))
			.returning();
		if (!moved) throw new Error("This label purchase was already settled");
		return {
			shipment: saved,
			completed: await completeIfAllBought(tx, attempt.dispatchId),
		};
	});
}

// Marks a packed dispatch bought once every box it planned has its label.
// Returns whether this call did it; safe to call any number of times.
export async function completeIfAllBought(db: Db, dispatchId: number) {
	const bought = db
		.select({ n: count() })
		.from(labelAttempts)
		.where(
			and(
				eq(labelAttempts.dispatchId, dispatchId),
				eq(labelAttempts.state, "succeeded"),
			),
		);
	const done = await db
		.update(dispatches)
		.set({ boughtAt: new Date() })
		.where(
			and(
				eq(dispatches.id, dispatchId),
				isNull(dispatches.boughtAt),
				eq(dispatches.contents, "packed"),
				sql`${dispatches.boxCount} = (${bought})`,
			),
		)
		.returning({ id: dispatches.id });
	return done.length > 0;
}

export type CheckOutside = {
	lock: OrderLocker;
	findShippo: typeof findLabel;
	findTiktok: typeof tiktokFindLabel;
};

export const liveCheck: CheckOutside = {
	lock: lockOnOwnConnection,
	findShippo: findLabel,
	findTiktok: tiktokFindLabel,
};

async function load(db: Db, attemptId: string) {
	const [attempt] = await db
		.select()
		.from(labelAttempts)
		.where(eq(labelAttempts.id, attemptId));
	if (!attempt) throw new Error("No such label purchase");
	return attempt;
}

async function lookup(db: Db, attempt: Attempt, outside: CheckOutside) {
	if (attempt.provider === "shippo") {
		return outside.findShippo(attempt.rateId, attempt.id);
	}
	if (!attempt.unitIds) return { kind: "pending" } as const;
	const [order] = await db
		.select({ marketplaceOrderId: orders.marketplaceOrderId })
		.from(dispatchOrders)
		.innerJoin(orders, eq(orders.id, dispatchOrders.orderId))
		.where(eq(dispatchOrders.dispatchId, attempt.dispatchId));
	if (!order) throw new Error("The purchase's order is gone");
	return outside.findTiktok(
		tiktokOrderId(order.marketplaceOrderId),
		attempt.unitIds,
	);
}

async function recordedElsewhere(db: Db, externalId: string) {
	const [found] = await db
		.select({ id: shipments.id })
		.from(shipments)
		.where(eq(shipments.externalId, externalId));
	return found !== undefined;
}

export type Checked = {
	attempt: Attempt;
	// The dispatch became fully bought, so its tracking can go out now.
	completed: boolean;
};

// Asks the provider what became of a purchase katasync never heard back
// on, and settles it from that: bought (its label is recorded, as if the
// answer had come), refused (nothing charged), or still unknown with what
// was found. Nothing found keeps it unknown: it may still have been
// charged. A settled one is returned as it is, so pressing twice, or
// checking after someone else did, changes nothing but finishing a
// dispatch whose boxes are all bought. Under the orders' locks, so it never
// overlaps the purchase itself.
export async function checkLabelAttempt(
	db: Db,
	attemptId: string,
	outside: CheckOutside = liveCheck,
): Promise<Checked> {
	const { dispatchId } = await load(db, attemptId);
	return outside.lock(await ordersOf(db, dispatchId), async () => {
		const attempt = await load(db, attemptId);
		if (settled(attempt.state)) {
			return {
				attempt,
				completed: await completeIfAllBought(db, dispatchId),
			};
		}
		const found: Lookup = await lookup(db, attempt, outside);
		switch (found.kind) {
			case "bought": {
				if (await recordedElsewhere(db, found.label.externalId)) {
					return {
						attempt: await settleWithout(db, attempt, "unknown", {
							error: "The label found is already recorded on another shipment",
							lastLookup: "pending",
						}),
						completed: false,
					};
				}
				const { completed } = await recordBought(db, attempt, found.label);
				return { attempt: await load(db, attemptId), completed };
			}
			case "refused":
				return {
					attempt: await settleWithout(db, attempt, "failed", {
						error: found.why,
					}),
					completed: false,
				};
			case "pending":
			case "none":
				return {
					attempt: await settleWithout(db, attempt, "unknown", {
						error: attempt.error ?? "No answer from the provider",
						lastLookup: found.kind,
					}),
					completed: false,
				};
		}
	});
}

// The unsettled purchases of these dispatches, for the order page.
export async function openAttempts(db: Db, dispatchIds: number[]) {
	if (dispatchIds.length === 0) return [];
	const rows = await db
		.select()
		.from(labelAttempts)
		.where(
			and(
				inArray(labelAttempts.dispatchId, dispatchIds),
				inArray(labelAttempts.state, ["pending", "unknown"]),
			),
		)
		.orderBy(labelAttempts.dispatchId, labelAttempts.boxIndex);
	return rows.map((a) => ({
		id: a.id,
		dispatchId: a.dispatchId,
		boxIndex: a.boxIndex,
		provider: a.provider,
		error: a.error,
		lastLookup: a.lastLookup,
	}));
}
