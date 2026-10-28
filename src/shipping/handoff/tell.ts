import { eq } from "drizzle-orm";
import type { Db } from "#/db/client";
import { dispatchOrders, type HandoffHold, orders } from "#/db/schema";
import { readQuantityMode } from "#/inventory/commitments";
import { consumeCommitments } from "#/inventory/commitments-consume";
import { assertTiktokShippable, deliver } from "../deliver";
import { type Destination, destinationOf } from "../destination";
import type { Handoff, Outside } from "../handoff";
import { type Contents, Held, type PackedLine, packedOf } from "../packed";
import { nextRetry } from "../retry-window";
import { type Box, type Member, sameMember, trackingChannels } from "./members";

export type Told = Handoff & { newly: boolean };

export const done = (sent: boolean, message: string, newly = false): Told => ({
	sent,
	message,
	newly,
});

// Records why an order is held for a person, and says so.
async function holdMember(
	db: Db,
	member: Member,
	name: string,
	held: HandoffHold,
	why: string,
): Promise<Told> {
	await db
		.update(dispatchOrders)
		.set({
			channelError: why,
			handoffHold: held,
			channelRetryAt: null,
			channelRetryLease: null,
		})
		.where(sameMember(member));
	return done(false, `Not sent to ${name}: ${why}`);
}

// Records a refusal to try again on its own, and says so.
async function failMember(
	db: Db,
	member: Member,
	name: string,
	phase: "delivery" | "recording",
	err: unknown,
): Promise<Told> {
	const detail = err instanceof Error ? err.message : String(err);
	if (err instanceof Held)
		return holdMember(db, member, name, err.hold, detail);
	const why =
		phase === "recording"
			? `Marketplace accepted tracking; inventory recording failed: ${detail}`
			: detail;
	const { handoff } = member;
	const now = new Date();
	const firstFailedAt = handoff.channelFirstFailedAt ?? now;
	const attempts = handoff.channelAttempts + 1;
	const retryAt = nextRetry(firstFailedAt, attempts, now);
	await db
		.update(dispatchOrders)
		.set({
			channelError: why,
			channelFirstFailedAt: firstFailedAt,
			channelAttempts: attempts,
			channelRetryAt: retryAt,
			channelRetryLease: null,
			handoffHold: null,
		})
		.where(sameMember(member));
	return done(
		false,
		`${phase === "recording" ? "Dispatch not recorded" : `Tracking didn't reach ${name}`}: ${why}${retryAt ? ". Retrying on its own; Diagnostics shows it if it gives up" : ""}`,
	);
}

// Everything katasync checks itself before telling an order's marketplace:
// either why it stops here, or where it goes and what was packed for it.
// A dispatch bought before contents were kept, a label that doesn't fit
// where the order was sold, or a missing inventory identity is held for a
// person instead.
async function gate(
	db: Db,
	member: Member,
	boxes: Box[],
	contents: Contents,
): Promise<
	| { kind: "stop"; result: Told }
	| {
			kind: "go";
			to: Exclude<Destination, { kind: "hold" }>;
			name: string;
			packed: PackedLine[];
			commitmentLines: { orderLineId: number; quantity: number }[];
	  }
> {
	const { order, channel, handoff } = member;
	const to = destinationOf(
		{ ...order, channel },
		boxes.map((b) => b.provider),
	);
	const name =
		to.kind === "hold"
			? (trackingChannels[channel] ?? channel)
			: trackingChannels[to.kind];
	const stop = (result: Told) => ({ kind: "stop" as const, result });
	if (handoff.channelSentAt) {
		return stop(done(true, `Tracking already sent to ${name}`));
	}
	// Telling the customer it shipped would be wrong; the box stays here.
	if (order.cancelledAt) {
		return stop(done(false, "The order was cancelled; void the label instead"));
	}
	if (
		order.financialStatus === "REFUNDED" ||
		order.financialStatus === "VOIDED"
	) {
		return stop(
			done(false, "The order was refunded or voided; void the label instead"),
		);
	}
	// A test label's tracking number is fake; customers must never get it.
	if (boxes.some((b) => b.test)) {
		return stop(done(false, `Test label, so ${name} wasn't told`));
	}
	if (contents.kind === "unknown") {
		return stop(
			await holdMember(
				db,
				member,
				name,
				{ kind: "unknownContents" },
				`bought before katasync kept what was packed, so it can't check the box against the order. Tell ${name} by hand, or void and ship again`,
			),
		);
	}
	if (to.kind === "hold")
		return stop(
			await holdMember(
				db,
				member,
				name,
				{ kind: "unmappable", why: to.why },
				to.why,
			),
		);
	const packed = packedOf(contents.lines, order.id);
	const commitmentLines = packed.flatMap((line) =>
		line.orderLineId == null
			? []
			: [{ orderLineId: line.orderLineId, quantity: line.quantity }],
	);
	if (
		commitmentLines.length !== packed.length &&
		(await readQuantityMode(db, "none")) === "committed"
	)
		return stop(
			await holdMember(
				db,
				member,
				name,
				{
					kind: "unmappable",
					why: "This dispatch has no frozen inventory line identity",
				},
				"Void and repack this dispatch before shipping reserved stock",
			),
		);
	return { kind: "go", to, name, packed, commitmentLines };
}

// One TikTok package holds every order of a combined box, so shipping it
// ships them all: before any is told, every order not yet told must pass
// its own checks, TikTok's units included. Returns the first that doesn't,
// with why (recorded on it as tell would), or null when all pass.
export async function blockerOfSharedPackage(
	db: Db,
	members: Member[],
	boxes: Box[],
	contents: Contents,
	outside: Outside,
): Promise<{ member: Member; result: Told } | null> {
	for (const member of members) {
		if (member.handoff.channelSentAt) continue;
		const checked = await gate(db, member, boxes, contents);
		if (checked.kind === "stop") return { member, result: checked.result };
		if (checked.to.kind !== "tiktok") continue;
		try {
			await assertTiktokShippable(
				db,
				{ to: checked.to, boxes, packed: checked.packed },
				outside,
			);
		} catch (err) {
			return {
				member,
				result: await failMember(db, member, checked.name, "delivery", err),
			};
		}
	}
	return null;
}

// Tells one order's marketplace, once katasync's own checks pass (gate) and
// the marketplace itself shows exactly what was packed still to ship (see
// deliver.ts); any mismatch is held for a person instead.
export async function tell(
	db: Db,
	member: Member,
	boxes: Box[],
	contents: Contents,
	outside: Outside,
): Promise<Told> {
	const checked = await gate(db, member, boxes, contents);
	if (checked.kind === "stop") return checked.result;
	const { to, name, packed, commitmentLines } = checked;
	const { order, handoff } = member;

	let phase: "delivery" | "recording" = "delivery";
	try {
		const delivered = await deliver(db, { to, order, boxes, packed }, outside);
		phase = "recording";
		// Recorded together, so a retry never finds it sent while the order is
		// still on To ship.
		await db.transaction(async (tx) => {
			if (
				(await readQuantityMode(tx)) === "committed" &&
				commitmentLines.length !== packed.length
			)
				throw new Error("The dispatch has no frozen inventory line identity");
			await consumeCommitments(tx, {
				orderId: order.id,
				lines: commitmentLines,
				fulfillmentKey: `dispatch:${handoff.dispatchId}:order:${order.id}`,
			});
			await tx
				.update(dispatchOrders)
				.set({
					channelSentAt: new Date(),
					channelFulfillmentId: delivered.fulfillmentId,
					channelError: null,
					channelRetryAt: null,
					channelRetryLease: null,
					handoffHold: null,
				})
				.where(sameMember(member));
			// Shipped now, not on the next sync: off To ship unless the
			// marketplace still has more of it to ship.
			await tx
				.update(orders)
				.set({
					fulfillmentStatus:
						delivered.remaining > 0 ? "PARTIALLY_FULFILLED" : "FULFILLED",
				})
				.where(eq(orders.id, order.id));
		});
	} catch (err) {
		return failMember(db, member, name, phase, err);
	}
	return done(
		true,
		to.kind === "tiktok"
			? "Ready for pickup on TikTok; TikTok tells the customer"
			: to.kind === "ebay" && boxes.length > 1
				? `Tracking sent to eBay; eBay takes one number, so the customer sees box 1's (${boxes[0].trackingNumber})`
				: `Tracking sent to ${name}; the customer is emailed`,
		true,
	);
}
