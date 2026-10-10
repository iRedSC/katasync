import { createServerFn } from "@tanstack/react-start";
import { getCookie, getRequest } from "@tanstack/react-start/server";
import { type } from "arktype";
import { asc, eq } from "drizzle-orm";
import {
	AuthError,
	createSetupLink,
	SESSION_COOKIE,
	SETUP_LINK_MINUTES,
	sessionFor,
} from "#/auth/sessions";
import { createApiToken, listApiTokens, revokeApiToken } from "#/auth/tokens";
import { passkeyName } from "#/auth/webauthn";
import { getDb } from "#/db/client";
import { passkeys } from "#/db/schema";

// The devices that can sign in, for Settings. Only reachable signed in.

export const listDevices = createServerFn({ method: "GET" }).handler(
	async () => {
		const db = getDb();
		const token = getCookie(SESSION_COOKIE);
		const session = token ? await sessionFor(db, token) : null;
		const rows = await db
			.select({
				id: passkeys.id,
				name: passkeys.name,
				createdAt: passkeys.createdAt,
				lastUsedAt: passkeys.lastUsedAt,
			})
			.from(passkeys)
			.orderBy(asc(passkeys.createdAt));
		return rows.map((p) => ({ ...p, current: p.id === session?.passkeyId }));
	},
);

export const renameDevice = createServerFn({ method: "POST" })
	.validator(type({ id: "string > 0", name: "string" }))
	.handler(async ({ data }) => {
		await getDb()
			.update(passkeys)
			.set({ name: passkeyName(data.name) })
			.where(eq(passkeys.id, data.id));
	});

// Removing a device's passkey also signs out every browser it signed in.
export const removeDevice = createServerFn({ method: "POST" })
	.validator(type({ id: "string > 0" }))
	.handler(async ({ data }) => {
		const removed = await getDb()
			.delete(passkeys)
			.where(eq(passkeys.id, data.id))
			.returning();
		if (removed.length === 0)
			throw new AuthError("That device is already gone");
	});

// A one-time link for adding a device, good for SETUP_LINK_MINUTES.
export const createDeviceLink = createServerFn({ method: "POST" }).handler(
	async () => {
		const token = await createSetupLink(getDb());
		const origin = process.env.AUTH_ORIGIN ?? new URL(getRequest().url).origin;
		return {
			url: `${origin}/setup?token=${token}`,
			expiresAt: new Date(Date.now() + SETUP_LINK_MINUTES * 60_000),
		};
	},
);

// Tokens for MCP clients like Claude. The token itself is only returned here,
// once.
export const listTokens = createServerFn({ method: "GET" }).handler(async () =>
	listApiTokens(getDb()),
);

export const createToken = createServerFn({ method: "POST" })
	.validator(type({ name: "string" }))
	.handler(async ({ data }) => {
		const token = await createApiToken(getDb(), data.name);
		const origin = process.env.AUTH_ORIGIN ?? new URL(getRequest().url).origin;
		return { token, endpoint: `${origin}/mcp` };
	});

export const revokeToken = createServerFn({ method: "POST" })
	.validator(type({ id: "string > 0" }))
	.handler(async ({ data }) => revokeApiToken(getDb(), data.id));
