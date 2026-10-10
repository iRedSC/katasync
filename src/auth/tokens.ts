import { desc, eq } from "drizzle-orm";
import type { Db } from "#/db/client";
import { apiTokens } from "#/db/schema";
import { AuthError, hashToken, newToken } from "./sessions";

// Tokens for programs that use /mcp, like Claude. Each is shown once when
// made; only its hash is kept.

// Marks tokens so a leaked one is recognizable (e.g. by secret scanners).
const PREFIX = "ks_";

export async function createApiToken(db: Db, rawName: string, canWrite = true) {
	const name = rawName.trim().replace(/\s+/g, " ");
	if (name === "") throw new AuthError("Say what the token is for");
	const token = `${PREFIX}${newToken()}`;
	await db
		.insert(apiTokens)
		.values({ tokenHash: hashToken(token), name, canWrite });
	return token;
}

// The token's row, or null for an unknown or revoked one. Notes when it was
// last used, at most once an hour.
export async function checkApiToken(db: Db, token: string, now = new Date()) {
	if (!token.startsWith(PREFIX)) return null;
	const tokenHash = hashToken(token);
	const [row] = await db
		.select()
		.from(apiTokens)
		.where(eq(apiTokens.tokenHash, tokenHash));
	if (!row) return null;
	if (!row.lastUsedAt || now.getTime() - row.lastUsedAt.getTime() > 3_600_000)
		await db
			.update(apiTokens)
			.set({ lastUsedAt: now })
			.where(eq(apiTokens.tokenHash, tokenHash));
	return row;
}

export function listApiTokens(db: Db) {
	return db
		.select({
			// The hash identifies a token without revealing it.
			id: apiTokens.tokenHash,
			name: apiTokens.name,
			canWrite: apiTokens.canWrite,
			createdAt: apiTokens.createdAt,
			lastUsedAt: apiTokens.lastUsedAt,
		})
		.from(apiTokens)
		.orderBy(desc(apiTokens.createdAt));
}

export async function revokeApiToken(db: Db, id: string) {
	await db.delete(apiTokens).where(eq(apiTokens.tokenHash, id));
}
