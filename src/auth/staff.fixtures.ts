import type { Db } from "#/db/client";
import { passkeyStaff, staff } from "#/db/identity-schema";
import { passkeys } from "#/db/schema";
import type { Actor, StaffRole } from "./actor";

export async function addPerson(
	db: Db,
	name: string,
	role: StaffRole,
	devices: string[] = [],
): Promise<Extract<Actor, { kind: "staff" }>> {
	const [row] = await db
		.insert(staff)
		.values({ name, role })
		.returning({ id: staff.id });
	for (const id of devices) {
		await db
			.insert(passkeys)
			.values({ id, publicKey: "key", name: `${name}'s ${id}` })
			.onConflictDoNothing();
		await db.insert(passkeyStaff).values({ passkeyId: id, staffId: row.id });
	}
	return {
		kind: "staff",
		staffId: row.id,
		name,
		role,
		via: { kind: "device", passkeyId: devices[0] ?? "none", name: "test" },
	};
}

export const legacyDevice = (passkeyId: string, name = "Old iPad"): Actor => ({
	kind: "legacy",
	via: { kind: "device", passkeyId, name },
});
