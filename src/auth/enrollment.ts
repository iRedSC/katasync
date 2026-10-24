import { and, eq, gt, isNull } from "drizzle-orm";
import type { Db } from "#/db/client";
import { setupLinkScopes, staff } from "#/db/identity-schema";
import { setupLinks } from "#/db/schema";
import type { Actor } from "./actor";
import { AuthError, hashToken, newToken } from "./sessions";

// A one-time link that lets a new device create a passkey for one named
// person. Who it's for is decided when it's made, never by the device that
// opens it. Links from before staff existed have no scope and don't work.

export const SETUP_LINK_MINUTES = 15;

export type Issuer = Extract<Actor, { kind: "staff" | "system" }>;

export async function issueSetupLink(
	tx: Db,
	issuer: Issuer,
	staffId: string,
	{ minutes = SETUP_LINK_MINUTES, now = new Date() } = {},
) {
	const [person] = await tx
		.select({ status: staff.status })
		.from(staff)
		.where(eq(staff.id, staffId))
		.for("share");
	if (!person) throw new AuthError("That person isn't on the staff list");
	if (person.status !== "active")
		throw new AuthError("Restore this person before adding a device");
	const token = newToken();
	const tokenHash = hashToken(token);
	const expiresAt = new Date(now.getTime() + minutes * 60_000);
	await tx.insert(setupLinks).values({ tokenHash, createdAt: now, expiresAt });
	await tx.insert(setupLinkScopes).values({
		tokenHash,
		staffId,
		issuedByStaffId: issuer.kind === "staff" ? issuer.staffId : null,
		issuedBySystem: issuer.kind === "system" ? issuer.name : null,
	});
	return { token, expiresAt };
}

export type SetupLink = {
	tokenHash: string;
	staffId: string;
	staffName: string;
};

export async function checkSetupLink(
	db: Db,
	token: string,
	now = new Date(),
): Promise<SetupLink> {
	const tokenHash = hashToken(token);
	const [link] = await db
		.select({
			usedAt: setupLinks.usedAt,
			expiresAt: setupLinks.expiresAt,
			staffId: setupLinkScopes.staffId,
			staffName: staff.name,
			status: staff.status,
		})
		.from(setupLinks)
		.leftJoin(
			setupLinkScopes,
			eq(setupLinkScopes.tokenHash, setupLinks.tokenHash),
		)
		.leftJoin(staff, eq(staff.id, setupLinkScopes.staffId))
		.where(eq(setupLinks.tokenHash, tokenHash));
	if (!link) throw new AuthError("This setup link isn't valid");
	if (link.usedAt) throw new AuthError("This setup link was already used");
	if (link.expiresAt <= now)
		throw new AuthError("This setup link expired; make a new one");
	if (!link.staffId || !link.staffName)
		throw new AuthError(
			"This setup link is from before staff; ask an owner for a new one",
		);
	if (link.status !== "active")
		throw new AuthError("This person was removed; ask an owner");
	return { tokenHash, staffId: link.staffId, staffName: link.staffName };
}

export async function spendSetupLink(
	tx: Db,
	token: string,
	now = new Date(),
): Promise<{ staffId: string }> {
	const tokenHash = hashToken(token);
	const used = await tx
		.update(setupLinks)
		.set({ usedAt: now })
		.where(
			and(
				eq(setupLinks.tokenHash, tokenHash),
				isNull(setupLinks.usedAt),
				gt(setupLinks.expiresAt, now),
			),
		)
		.returning({ tokenHash: setupLinks.tokenHash });
	if (used.length === 0)
		throw new AuthError("This setup link was already used or expired");
	const [scope] = await tx
		.select({ staffId: setupLinkScopes.staffId, status: staff.status })
		.from(setupLinkScopes)
		.innerJoin(staff, eq(staff.id, setupLinkScopes.staffId))
		.where(eq(setupLinkScopes.tokenHash, tokenHash))
		.for("share", { of: staff });
	if (!scope)
		throw new AuthError(
			"This setup link is from before staff; ask an owner for a new one",
		);
	if (scope.status !== "active")
		throw new AuthError("This person was removed; ask an owner");
	return { staffId: scope.staffId };
}
