import { createHash, randomBytes } from "node:crypto";
import { and, eq, gt, isNull, lt } from "drizzle-orm";
import type { Db } from "#/db/client";
import { authChallenges, sessions, setupLinks } from "#/db/schema";

// Sessions, setup links, and challenges: the parts of sign-in that are just
// rows with expiry dates. The passkey ceremonies are in webauthn.ts.

export class AuthError extends Error {
	name = "AuthError";
}

// A signed-in browser stays signed in this long after it was last used.
export const SESSION_DAYS = 90;
const DAY = 86_400_000;
// The expiry is pushed forward at most once a day, not on every request.
const RENEW_AFTER = DAY;

export const SESSION_COOKIE = "katasync_session";

// The cookie lives as long as the session does, so it's set again whenever
// the session is renewed. A maxAge of 0 clears it.
export const sessionCookie = (token: string, maxAge = SESSION_DAYS * 86_400) =>
	`${SESSION_COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;

export const newToken = () => randomBytes(32).toString("base64url");
export const hashToken = (token: string) =>
	createHash("sha256").update(token).digest("base64url");

export async function createSession(
	db: Db,
	passkeyId: string,
	now = new Date(),
) {
	const token = newToken();
	await db.insert(sessions).values({
		tokenHash: hashToken(token),
		passkeyId,
		createdAt: now,
		expiresAt: new Date(now.getTime() + SESSION_DAYS * DAY),
	});
	return token;
}

// The session a cookie's token belongs to, or null when it's unknown or
// expired. Renews it while it's in use; `renewed` tells the caller to send the
// browser a fresh cookie.
export async function sessionFor(db: Db, token: string, now = new Date()) {
	const tokenHash = hashToken(token);
	const [session] = await db
		.select()
		.from(sessions)
		.where(and(eq(sessions.tokenHash, tokenHash), gt(sessions.expiresAt, now)));
	if (!session) return null;
	const expiresAt = new Date(now.getTime() + SESSION_DAYS * DAY);
	const renewed =
		expiresAt.getTime() - session.expiresAt.getTime() > RENEW_AFTER;
	if (renewed)
		await db
			.update(sessions)
			.set({ expiresAt })
			.where(eq(sessions.tokenHash, tokenHash));
	return { ...session, renewed };
}

export async function endSession(db: Db, token: string) {
	await db.delete(sessions).where(eq(sessions.tokenHash, hashToken(token)));
}

// A link a new device opens to create its passkey.
export const SETUP_LINK_MINUTES = 15;

export async function createSetupLink(
	db: Db,
	minutes = SETUP_LINK_MINUTES,
	now = new Date(),
) {
	const token = newToken();
	await db.insert(setupLinks).values({
		tokenHash: hashToken(token),
		createdAt: now,
		expiresAt: new Date(now.getTime() + minutes * 60_000),
	});
	return token;
}

// Throws unless the link is real, unused, and in date.
export async function checkSetupLink(db: Db, token: string, now = new Date()) {
	const [link] = await db
		.select()
		.from(setupLinks)
		.where(eq(setupLinks.tokenHash, hashToken(token)));
	if (!link) throw new AuthError("This setup link isn't valid");
	if (link.usedAt) throw new AuthError("This setup link was already used");
	if (link.expiresAt <= now)
		throw new AuthError("This setup link expired; make a new one");
}

// Marks the link used. Only one device can win a race for it.
export async function useSetupLink(db: Db, token: string, now = new Date()) {
	const used = await db
		.update(setupLinks)
		.set({ usedAt: now })
		.where(
			and(
				eq(setupLinks.tokenHash, hashToken(token)),
				isNull(setupLinks.usedAt),
				gt(setupLinks.expiresAt, now),
			),
		)
		.returning();
	if (used.length === 0)
		throw new AuthError("This setup link was already used or expired");
}

// A passkey prompt has this long to be answered.
const CHALLENGE_MINUTES = 5;

export async function saveChallenge(
	db: Db,
	challenge: string,
	now = new Date(),
) {
	await db.delete(authChallenges).where(lt(authChallenges.expiresAt, now));
	await db.insert(authChallenges).values({
		challenge,
		expiresAt: new Date(now.getTime() + CHALLENGE_MINUTES * 60_000),
	});
}

// True once for a challenge we issued and that's still in date.
export async function consumeChallenge(
	db: Db,
	challenge: string,
	now = new Date(),
) {
	const used = await db
		.delete(authChallenges)
		.where(
			and(
				eq(authChallenges.challenge, challenge),
				gt(authChallenges.expiresAt, now),
			),
		)
		.returning();
	return used.length > 0;
}
