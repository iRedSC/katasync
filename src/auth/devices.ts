import { asc, eq } from "drizzle-orm";
import type { Db } from "#/db/client";
import { passkeyStaff, staff } from "#/db/identity-schema";
import { passkeys } from "#/db/schema";
import type { Actor } from "./actor";
import {
	assertKeepsOwner,
	assertOwner,
	lockOwners,
	plainDbError,
} from "./authority";
import { AuthError } from "./sessions";
import { passkeyName } from "./webauthn";

// The passkeys that sign in, and who each belongs to. An unassigned one is
// from before staff existed; an owner gives it to the person who uses it.
// Removing one signs out every browser it signed in.

export async function listDevices(db: Db) {
	return db
		.select({
			id: passkeys.id,
			name: passkeys.name,
			createdAt: passkeys.createdAt,
			lastUsedAt: passkeys.lastUsedAt,
			staffId: staff.id,
			staffName: staff.name,
		})
		.from(passkeys)
		.leftJoin(passkeyStaff, eq(passkeyStaff.passkeyId, passkeys.id))
		.leftJoin(staff, eq(staff.id, passkeyStaff.staffId))
		.orderBy(asc(passkeys.createdAt));
}

export async function renameDevice(
	db: Db,
	by: Actor,
	passkeyId: string,
	rawName: string,
) {
	const name = passkeyName(rawName);
	await db.transaction(async (tx) => {
		await assertOwner(tx, by);
		const changed = await tx
			.update(passkeys)
			.set({ name })
			.where(eq(passkeys.id, passkeyId))
			.returning({ id: passkeys.id });
		if (changed.length === 0)
			throw new AuthError("That device is already gone");
	});
}

export async function removeDevice(db: Db, by: Actor, passkeyId: string) {
	await db
		.transaction(async (tx) => {
			await lockOwners(tx);
			await assertOwner(tx, by);
			await assertKeepsOwner(tx, { kind: "device-removed", passkeyId });
			const removed = await tx
				.delete(passkeys)
				.where(eq(passkeys.id, passkeyId))
				.returning({ id: passkeys.id });
			if (removed.length === 0)
				throw new AuthError("That device is already gone");
		})
		.catch((error) => plainDbError(error));
}

export async function assignDevice(
	db: Db,
	by: Actor,
	passkeyId: string,
	staffId: string,
) {
	await db.transaction(async (tx) => {
		await assertOwner(tx, by);
		const [person] = await tx
			.select({ status: staff.status })
			.from(staff)
			.where(eq(staff.id, staffId))
			.for("share");
		if (person?.status !== "active")
			throw new AuthError("That person isn't on the staff");
		const [device] = await tx
			.select({ id: passkeys.id })
			.from(passkeys)
			.where(eq(passkeys.id, passkeyId));
		if (!device) throw new AuthError("That device is already gone");
		const bound = await tx
			.insert(passkeyStaff)
			.values({ passkeyId, staffId })
			.onConflictDoNothing()
			.returning({ id: passkeyStaff.passkeyId });
		if (bound.length === 0)
			throw new AuthError("That device already belongs to someone");
	});
}
