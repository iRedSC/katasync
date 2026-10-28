import { randomUUID } from "node:crypto";
import { and, eq, lt, or } from "drizzle-orm";
import type { Db } from "#/db/client";
import { poEmailAi } from "#/db/schema";
import { PurchaseOrderError } from "#/purchasing/orders";

// Which run holds an email the AI is filing (src/purchasing/inbox
// /ai-filing.ts), so a run that died, or ran so long another took its email
// over, can't write over the one that has it now.

// A claim this old is from a run that died; take it over.
const CLAIM_STALE_MS = 5 * 60_000;
// A failed email is tried again this long after.
const RETRY_FAILED_MS = 30 * 60_000;

// Which claims a run may take: none yet, a failure old enough to try again,
// or a dead run's.
export function takeable(now: Date) {
	return or(
		and(
			eq(poEmailAi.state, "failed"),
			lt(poEmailAi.updatedAt, new Date(now.getTime() - RETRY_FAILED_MS)),
		),
		and(
			eq(poEmailAi.state, "working"),
			lt(poEmailAi.updatedAt, new Date(now.getTime() - CLAIM_STALE_MS)),
		),
	);
}

// Takes the email for this run: its claim, new each time, which every write
// the run makes needs. Null when another run has it.
export async function claim(db: Db, emailId: number, now: Date) {
	const token = randomUUID();
	const [row] = await db
		.insert(poEmailAi)
		.values({ emailId, state: "working", claim: token, updatedAt: now })
		.onConflictDoUpdate({
			target: poEmailAi.emailId,
			set: { state: "working", error: null, claim: token, updatedAt: now },
			setWhere: takeable(now),
		})
		.returning({ emailId: poEmailAi.emailId });
	return row ? token : null;
}

// The run's claim is still its own: no run took it over after it went stale.
export function held(token: string) {
	return and(eq(poEmailAi.state, "working"), eq(poEmailAi.claim, token));
}

// Another run took the email over: this one writes nothing more for it.
export class ClaimLostError extends Error {
	name = "ClaimLostError";
	constructor() {
		super("Another run took it over");
	}
}

// Who may file the email: the run holding its claim, or staff taking the
// AI's suggestion.
export type Holder = { by: "ai"; claim: string } | { by: "staff" };

// Locks the email's AI row while the holder still holds it, until the
// transaction ends, so nobody else settles it meanwhile.
export async function lockHeld(tx: Db, emailId: number, holder: Holder) {
	const [row] = await tx
		.select({ emailId: poEmailAi.emailId })
		.from(poEmailAi)
		.where(
			and(
				eq(poEmailAi.emailId, emailId),
				holder.by === "ai"
					? held(holder.claim)
					: eq(poEmailAi.state, "suggested"),
			),
		)
		.for("update");
	if (row) return;
	if (holder.by === "ai") throw new ClaimLostError();
	throw new PurchaseOrderError("There's no suggestion for that email now");
}

// Ends this run's claim. Throws ClaimLostError when another run took it.
export async function settle(
	db: Db,
	emailId: number,
	token: string,
	set: Partial<typeof poEmailAi.$inferInsert>,
) {
	const [row] = await db
		.update(poEmailAi)
		.set({ ...set, updatedAt: new Date() })
		.where(and(eq(poEmailAi.emailId, emailId), held(token)))
		.returning({ emailId: poEmailAi.emailId });
	if (!row) throw new ClaimLostError();
}
