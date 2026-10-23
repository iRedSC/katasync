import { and, eq, sql } from "drizzle-orm";
import type { Db } from "#/db/client";
import { passkeyStaff, staff } from "#/db/identity-schema";
import { type Actor, Forbidden, mayAdminister } from "./actor";
import type { Issuer } from "./enrollment";
import { AuthError } from "./sessions";

// Only owners run the staff list, devices, and app connections. Every such
// change re-reads the owner's row inside its own transaction, so a demotion
// or removal that lands first wins. Changes that could leave no owner able
// to sign in take one lock first; the database checks the same rule
// (guard_last_owner in src/db/pending/identity.sql).

export const ONLY_OWNERS = "Only an owner can do this";

export async function assertOwner(tx: Db, by: Actor): Promise<Issuer> {
	switch (by.kind) {
		case "system":
			if (!mayAdminister(by)) throw new Forbidden(ONLY_OWNERS);
			return by;
		case "legacy":
			throw new Forbidden(ONLY_OWNERS);
		case "staff": {
			const [row] = await tx
				.select({ role: staff.role, status: staff.status })
				.from(staff)
				.where(eq(staff.id, by.staffId))
				.for("share");
			if (row?.status !== "active" || row.role !== "owner")
				throw new Forbidden(ONLY_OWNERS);
			return { ...by, role: "owner" };
		}
	}
}

export const lockOwners = (tx: Db) =>
	tx.execute(
		sql`update staff_owner_guard set generation = generation + 1 where singleton`,
	);

export type OwnerSnapshot = ReadonlyArray<{
	staffId: string;
	passkeyIds: readonly string[];
}>;

export type OwnerChange =
	| { kind: "owner-leaves"; staffId: string }
	| { kind: "device-removed"; passkeyId: string };

export function leavesUsableOwner(
	owners: OwnerSnapshot,
	change: OwnerChange,
): boolean {
	const usable = (list: OwnerSnapshot) =>
		list.filter((o) => o.passkeyIds.length > 0).length;
	if (usable(owners) === 0) return true;
	const after =
		change.kind === "owner-leaves"
			? owners.filter((o) => o.staffId !== change.staffId)
			: owners.map((o) => ({
					...o,
					passkeyIds: o.passkeyIds.filter((p) => p !== change.passkeyId),
				}));
	return usable(after) > 0;
}

export async function ownerSnapshot(tx: Db): Promise<OwnerSnapshot> {
	const rows = await tx
		.select({ staffId: staff.id, passkeyId: passkeyStaff.passkeyId })
		.from(staff)
		.leftJoin(passkeyStaff, eq(passkeyStaff.staffId, staff.id))
		.where(and(eq(staff.role, "owner"), eq(staff.status, "active")));
	const owners = new Map<string, string[]>();
	for (const { staffId, passkeyId } of rows) {
		const list = owners.get(staffId) ?? [];
		if (passkeyId) list.push(passkeyId);
		owners.set(staffId, list);
	}
	return [...owners].map(([staffId, passkeyIds]) => ({ staffId, passkeyIds }));
}

export const LAST_OWNER = "Keep at least one owner who can sign in";

export async function assertKeepsOwner(tx: Db, change: OwnerChange) {
	if (!leavesUsableOwner(await ownerSnapshot(tx), change))
		throw new AuthError(LAST_OWNER);
}

const pgCode = (error: unknown): unknown =>
	error && typeof error === "object"
		? "code" in error
			? error.code
			: "cause" in error
				? pgCode(error.cause)
				: undefined
		: undefined;

export function plainDbError(error: unknown, duplicate?: string): never {
	const code = pgCode(error);
	if (code === "KA001") throw new AuthError(LAST_OWNER);
	if (code === "23505" && duplicate) throw new AuthError(duplicate);
	throw error;
}

export function personName(raw: string) {
	const name = raw.trim().replace(/\s+/g, " ");
	if (name === "") throw new AuthError("Give a name");
	if (name.length > 40) throw new AuthError("Keep the name under 40");
	return name;
}
