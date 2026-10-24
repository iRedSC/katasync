import { eq } from "drizzle-orm";
import type { Db } from "#/db/client";
import { passkeyStaff, staff } from "#/db/identity-schema";
import { passkeys } from "#/db/schema";
import type { Actor } from "./actor";
import { sessionFor } from "./sessions";

// Who a passkey or session acts as, read fresh on every request so a role
// change or removal takes effect on the next one.

export type Standing =
	| { kind: "active"; actor: Extract<Actor, { kind: "staff" | "legacy" }> }
	| { kind: "removed" }
	| { kind: "unknown" };

export async function standingOfPasskey(
	db: Db,
	passkeyId: string,
): Promise<Standing> {
	const [row] = await db
		.select({
			deviceName: passkeys.name,
			staffId: staff.id,
			staffName: staff.name,
			role: staff.role,
			status: staff.status,
		})
		.from(passkeys)
		.leftJoin(passkeyStaff, eq(passkeyStaff.passkeyId, passkeys.id))
		.leftJoin(staff, eq(staff.id, passkeyStaff.staffId))
		.where(eq(passkeys.id, passkeyId));
	if (!row) return { kind: "unknown" };
	const via = { kind: "device" as const, passkeyId, name: row.deviceName };
	if (row.staffId === null || row.staffName === null || row.role === null)
		return { kind: "active", actor: { kind: "legacy", via } };
	if (row.status !== "active") return { kind: "removed" };
	return {
		kind: "active",
		actor: {
			kind: "staff",
			staffId: row.staffId,
			name: row.staffName,
			role: row.role,
			via,
		},
	};
}

export type SessionStanding =
	| {
			kind: "signed-in";
			actor: Extract<Actor, { kind: "staff" | "legacy" }>;
			renewed: boolean;
	  }
	| { kind: "signed-out" };

export async function standingOfSession(
	db: Db,
	token: string,
	now = new Date(),
): Promise<SessionStanding> {
	const session = await sessionFor(db, token, now);
	if (!session) return { kind: "signed-out" };
	const standing = await standingOfPasskey(db, session.passkeyId);
	if (standing.kind !== "active") return { kind: "signed-out" };
	return { kind: "signed-in", actor: standing.actor, renewed: session.renewed };
}
