import { and, asc, count, eq, inArray, sql } from "drizzle-orm";
import type { Db } from "#/db/client";
import { passkeyStaff, staff } from "#/db/identity-schema";
import { sessions } from "#/db/schema";
import { type Actor, Forbidden, type StaffRole } from "./actor";
import {
	assertKeepsOwner,
	assertOwner,
	lockOwners,
	personName,
	plainDbError,
} from "./authority";
import { issueSetupLink } from "./enrollment";
import { AuthError } from "./sessions";

// The named people who sign in. Owners add people, change roles, and remove
// or restore them; removing ends their sessions and stops their devices and
// connected apps until they're restored.

export async function listStaff(db: Db) {
	return db
		.select({
			id: staff.id,
			name: staff.name,
			role: staff.role,
			status: staff.status,
			devices: count(passkeyStaff.passkeyId),
		})
		.from(staff)
		.leftJoin(passkeyStaff, eq(passkeyStaff.staffId, staff.id))
		.groupBy(staff.id)
		.orderBy(asc(staff.status), asc(staff.name));
}

const taken = (name: string) => `Someone is already called ${name}`;

export async function addStaff(
	db: Db,
	by: Actor,
	input: { name: string; role: StaffRole },
	now = new Date(),
) {
	const name = personName(input.name);
	return db
		.transaction(async (tx) => {
			const issuer = await assertOwner(tx, by);
			const [row] = await tx
				.insert(staff)
				.values({ name, role: input.role, createdAt: now })
				.returning({ id: staff.id });
			const link = await issueSetupLink(tx, issuer, row.id, { now });
			return { staffId: row.id, ...link };
		})
		.catch((error) => plainDbError(error, taken(name)));
}

export async function setupLinkForStaff(
	db: Db,
	by: Actor,
	staffId: string,
	now = new Date(),
) {
	return db.transaction(async (tx) =>
		issueSetupLink(tx, await assertOwner(tx, by), staffId, { now }),
	);
}

export async function setRole(
	db: Db,
	by: Actor,
	staffId: string,
	role: StaffRole,
) {
	await db
		.transaction(async (tx) => {
			await lockOwners(tx);
			await assertOwner(tx, by);
			if (role === "operator")
				await assertKeepsOwner(tx, { kind: "owner-leaves", staffId });
			const changed = await tx
				.update(staff)
				.set({ role })
				.where(and(eq(staff.id, staffId), eq(staff.status, "active")))
				.returning({ id: staff.id });
			if (changed.length === 0)
				throw new AuthError("Restore this person before changing their role");
		})
		.catch((error) => plainDbError(error));
}

export async function removeStaff(db: Db, by: Actor, staffId: string) {
	await db
		.transaction(async (tx) => {
			await lockOwners(tx);
			await assertOwner(tx, by);
			await assertKeepsOwner(tx, { kind: "owner-leaves", staffId });
			const changed = await tx
				.update(staff)
				.set({ status: "removed" })
				.where(and(eq(staff.id, staffId), eq(staff.status, "active")))
				.returning({ id: staff.id });
			if (changed.length === 0) throw new AuthError("Already removed");
			const devices = tx
				.select({ id: passkeyStaff.passkeyId })
				.from(passkeyStaff)
				.where(eq(passkeyStaff.staffId, staffId));
			await tx.delete(sessions).where(inArray(sessions.passkeyId, devices));
		})
		.catch((error) => plainDbError(error));
}

export async function restoreStaff(db: Db, by: Actor, staffId: string) {
	await db.transaction(async (tx) => {
		await assertOwner(tx, by);
		const changed = await tx
			.update(staff)
			.set({ status: "active" })
			.where(and(eq(staff.id, staffId), eq(staff.status, "removed")))
			.returning({ id: staff.id });
		if (changed.length === 0) throw new AuthError("Already on the staff");
	});
}

export async function claimOwnership(
	db: Db,
	by: Actor,
	rawName: string,
	now = new Date(),
) {
	if (by.kind !== "legacy" || by.via.kind !== "device")
		throw new Forbidden("Only an unassigned device can set up the first owner");
	const passkeyId = by.via.passkeyId;
	const name = personName(rawName);
	return db
		.transaction(async (tx) => {
			await lockOwners(tx);
			const [owner] = await tx.select({ id: staff.id }).from(staff).limit(1);
			if (owner)
				throw new Forbidden(
					"Staff is already set up; ask an owner or use recovery",
				);
			const [row] = await tx
				.insert(staff)
				.values({ name, role: "owner", createdAt: now })
				.returning({ id: staff.id });
			const bound = await tx
				.insert(passkeyStaff)
				.values({ passkeyId, staffId: row.id, boundAt: now })
				.onConflictDoNothing()
				.returning({ id: passkeyStaff.passkeyId });
			if (bound.length === 0)
				throw new AuthError("This device already belongs to someone");
			return { staffId: row.id };
		})
		.catch((error) => plainDbError(error, taken(name)));
}

export async function recoverOwner(
	db: Db,
	by: Extract<Actor, { kind: "system" }> & { name: "recovery-script" },
	rawName: string,
	{ minutes = 30, now = new Date() } = {},
) {
	const name = personName(rawName);
	return db
		.transaction(async (tx) => {
			await lockOwners(tx);
			const [found] = await tx
				.select({ id: staff.id, role: staff.role, status: staff.status })
				.from(staff)
				.where(eq(sql`lower(${staff.name})`, name.toLowerCase()))
				.for("update");
			let outcome: "created" | "reinstated" | "unchanged";
			let staffId: string;
			if (!found) {
				const [row] = await tx
					.insert(staff)
					.values({ name, role: "owner", createdAt: now })
					.returning({ id: staff.id });
				staffId = row.id;
				outcome = "created";
			} else {
				staffId = found.id;
				outcome =
					found.role === "owner" && found.status === "active"
						? "unchanged"
						: "reinstated";
				if (outcome === "reinstated")
					await tx
						.update(staff)
						.set({ role: "owner", status: "active" })
						.where(eq(staff.id, staffId));
			}
			const link = await issueSetupLink(tx, by, staffId, { minutes, now });
			return { outcome, staffId, ...link };
		})
		.catch((error) => plainDbError(error, taken(name)));
}
