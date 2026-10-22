import { createHash } from "node:crypto";
import { and, desc, eq, gt, isNull, lt, notExists } from "drizzle-orm";
import type { Db } from "#/db/client";
import {
	oauthClients,
	oauthCodes,
	oauthGrants,
	oauthTokens,
} from "#/db/schema";
import { hashToken, newToken } from "./sessions";

// OAuth 2.1 for /mcp, as the MCP spec asks: an app registers itself, someone
// signed in approves it on /oauth/authorize (choosing read only or not), and
// the app trades the code for tokens with PKCE. Public clients only, so
// there are no client secrets. The endpoints are in src/routes/api/oauth/
// and src/routes/[.]well-known/.

// Marks tokens so a leaked one is recognizable, and so the MCP log can strip
// them (src/mcp/log.ts).
const PREFIX = "ks_";
export const ACCESS_SECONDS = 3600;
// A connection not used for this long has to be approved again.
const REFRESH_DAYS = 90;
const CODE_MINUTES = 5;
// An app that registered but was never approved.
const UNUSED_CLIENT_DAYS = 1;
const DAY = 86_400_000;

// A refusal the endpoint reports as { error, error_description }.
export class OAuthError extends Error {
	name = "OAuthError";
	constructor(
		readonly code:
			| "invalid_request"
			| "invalid_client"
			| "invalid_grant"
			| "unsupported_grant_type"
			| "invalid_redirect_uri"
			| "invalid_client_metadata",
		message: string,
	) {
		super(message);
	}
}

// Where the endpoints are, for the metadata documents and the 401 /mcp sends.
export function endpoints(origin: string) {
	return {
		resource: `${origin}/mcp`,
		resourceMetadata: `${origin}/.well-known/oauth-protected-resource/mcp`,
		issuer: origin,
		authorize: `${origin}/oauth/authorize`,
		token: `${origin}/api/oauth/token`,
		register: `${origin}/api/oauth/register`,
	};
}

export const originOf = (request: Request) =>
	process.env.AUTH_ORIGIN ?? new URL(request.url).origin;

// Approval sends the browser back here with the code, so only an https
// address, or one on this computer (how Claude Code listens, RFC 8252).
// Custom schemes like a desktop app's are refused.
// An address it's safe to send the browser to. The browser only ever goes
// to one of these: back() takes nothing else, so a client stored before a
// check was tightened still can't send it anywhere else.
type SafeRedirect = string & { readonly safe: unique symbol };

function safeRedirect(uri: string): SafeRedirect | null {
	let url: URL;
	try {
		url = new URL(uri);
	} catch {
		return null;
	}
	if (url.hash) return null;
	const ok =
		url.protocol === "https:" ||
		(url.protocol === "http:" &&
			["localhost", "127.0.0.1", "[::1]"].includes(url.hostname));
	return ok ? (uri as SafeRedirect) : null;
}

// Dynamic client registration (RFC 7591).
export async function registerClient(
	db: Db,
	metadata: { client_name?: unknown; redirect_uris?: unknown },
	now = new Date(),
) {
	const uris = metadata.redirect_uris;
	if (
		!Array.isArray(uris) ||
		uris.length === 0 ||
		uris.length > 10 ||
		!uris.every((u) => typeof u === "string")
	)
		throw new OAuthError(
			"invalid_redirect_uri",
			"Give redirect_uris, a list of up to 10 addresses",
		);
	// Every one is checked: an index, not the address itself, so an empty
	// address can't read as "none refused".
	const refused = uris.findIndex((u) => safeRedirect(u) === null);
	if (refused !== -1)
		throw new OAuthError(
			"invalid_redirect_uri",
			`${JSON.stringify(uris[refused])} isn't an https address or one on this computer`,
		);
	const name =
		typeof metadata.client_name === "string" &&
		metadata.client_name.trim() !== ""
			? metadata.client_name.trim().replace(/\s+/g, " ").slice(0, 100)
			: "An unnamed app";

	// Anyone can register, so apps nobody approved don't pile up.
	await db
		.delete(oauthClients)
		.where(
			and(
				lt(
					oauthClients.createdAt,
					new Date(now.getTime() - UNUSED_CLIENT_DAYS * DAY),
				),
				notExists(
					db
						.select()
						.from(oauthGrants)
						.where(eq(oauthGrants.clientId, oauthClients.id)),
				),
			),
		);
	const id = newToken();
	await db
		.insert(oauthClients)
		.values({ id, name, redirectUris: uris, createdAt: now });
	return {
		client_id: id,
		client_id_issued_at: Math.floor(now.getTime() / 1000),
		client_name: name,
		redirect_uris: uris,
		grant_types: ["authorization_code", "refresh_token"],
		response_types: ["code"],
		token_endpoint_auth_method: "none",
	};
}

// What /oauth/authorize was asked, as the app sent it.
export type AuthorizeParams = Partial<
	Record<
		| "response_type"
		| "client_id"
		| "redirect_uri"
		| "code_challenge"
		| "code_challenge_method"
		| "state"
		| "resource",
		string
	>
>;

// What the approval page does with a request:
// - invalid: the app or its address is unknown, so the browser can't safely
//   be sent back; the page says why.
// - refused: the app is real but asked wrongly; it's told so at its address.
// - ask: show who wants in and let the person choose.
export type AuthorizeCheck =
	| { kind: "invalid"; message: string }
	| { kind: "refused"; redirect: string }
	| {
			kind: "ask";
			clientName: string;
			// Where approving sends the browser, to show before it does.
			redirectHost: string;
	  };

type Valid = {
	client: typeof oauthClients.$inferSelect;
	redirectUri: SafeRedirect;
	codeChallenge: string;
	state: string | undefined;
};

function back(
	redirectUri: SafeRedirect,
	issuer: string,
	params: Record<string, string | undefined>,
) {
	const url = new URL(redirectUri);
	for (const [k, v] of Object.entries(params))
		if (v !== undefined) url.searchParams.set(k, v);
	// RFC 9207, so the app knows which server answered.
	url.searchParams.set("iss", issuer);
	return url.toString();
}

async function validate(
	db: Db,
	p: AuthorizeParams,
	origin: string,
): Promise<
	| { kind: "invalid"; message: string }
	| { kind: "refused"; redirect: string }
	| { kind: "valid"; valid: Valid }
> {
	const [client] = p.client_id
		? await db
				.select()
				.from(oauthClients)
				.where(eq(oauthClients.id, p.client_id))
		: [];
	if (!client)
		return {
			kind: "invalid",
			message:
				"This app isn't registered with katasync. Try connecting from the app again.",
		};
	const asked =
		p.redirect_uri ??
		(client.redirectUris.length === 1 ? client.redirectUris[0] : undefined);
	const redirectUri =
		asked !== undefined && client.redirectUris.includes(asked)
			? safeRedirect(asked)
			: null;
	if (!redirectUri)
		return {
			kind: "invalid",
			message: `${client.name} asked to be sent back to an address it didn't register.`,
		};
	const { issuer, resource } = endpoints(origin);
	const refuse = (description: string, error = "invalid_request") => ({
		kind: "refused" as const,
		redirect: back(redirectUri, issuer, {
			error,
			error_description: description,
			state: p.state,
		}),
	});
	if (p.response_type !== "code")
		return refuse("Only response_type=code", "unsupported_response_type");
	if (!p.code_challenge || p.code_challenge_method !== "S256")
		return refuse("PKCE with code_challenge_method=S256 is required");
	if (p.resource !== undefined && p.resource !== resource)
		return refuse(`The only resource here is ${resource}`, "invalid_target");
	return {
		kind: "valid",
		valid: {
			client,
			redirectUri,
			codeChallenge: p.code_challenge,
			state: p.state,
		},
	};
}

export async function checkAuthorize(
	db: Db,
	p: AuthorizeParams,
	origin: string,
): Promise<AuthorizeCheck> {
	const v = await validate(db, p, origin);
	if (v.kind !== "valid") return v;
	return {
		kind: "ask",
		clientName: v.valid.client.name,
		redirectHost: new URL(v.valid.redirectUri).host,
	};
}

// The person's answer. Approving makes the grant and a one-time code; either
// way, where to send the browser.
export async function answerAuthorize(
	db: Db,
	p: AuthorizeParams,
	origin: string,
	answer: { approve: true; canWrite: boolean } | { approve: false },
	now = new Date(),
): Promise<
	{ kind: "invalid"; message: string } | { kind: "redirect"; url: string }
> {
	const v = await validate(db, p, origin);
	if (v.kind === "invalid") return v;
	if (v.kind === "refused") return { kind: "redirect", url: v.redirect };
	const { client, redirectUri, codeChallenge, state } = v.valid;
	const { issuer } = endpoints(origin);
	if (!answer.approve)
		return {
			kind: "redirect",
			url: back(redirectUri, issuer, {
				error: "access_denied",
				error_description: "Not approved in katasync",
				state,
			}),
		};
	const code = newToken();
	await db.transaction(async (tx) => {
		// Kept past use until they expire, to catch a second try.
		await tx.delete(oauthCodes).where(lt(oauthCodes.expiresAt, now));
		const [grant] = await tx
			.insert(oauthGrants)
			.values({
				clientId: client.id,
				canWrite: answer.canWrite,
				createdAt: now,
			})
			.returning();
		await tx.insert(oauthCodes).values({
			codeHash: hashToken(code),
			grantId: grant.id,
			redirectUri,
			codeChallenge,
			expiresAt: new Date(now.getTime() + CODE_MINUTES * 60_000),
		});
	});
	return { kind: "redirect", url: back(redirectUri, issuer, { code, state }) };
}

const FOREIGN_KEY_VIOLATION = "23503";
// Drizzle wraps the driver's error; both drivers put Postgres's code on it.
const pgCode = (error: unknown): unknown =>
	error && typeof error === "object"
		? "code" in error
			? error.code
			: "cause" in error
				? pgCode(error.cause)
				: undefined
		: undefined;

const s256 = (verifier: string) =>
	createHash("sha256").update(verifier).digest("base64url");

async function issue(
	db: Db,
	grant: { id: string; canWrite: boolean },
	now: Date,
) {
	const access = `${PREFIX}${newToken()}`;
	const refresh = `${PREFIX}${newToken()}`;
	await db
		.delete(oauthTokens)
		.where(
			and(eq(oauthTokens.grantId, grant.id), lt(oauthTokens.expiresAt, now)),
		);
	// A reuse caught by a racing request may have just ended the grant; the
	// foreign key then refuses these, and none outlive it.
	await db
		.insert(oauthTokens)
		.values([
			{
				tokenHash: hashToken(access),
				kind: "access",
				grantId: grant.id,
				expiresAt: new Date(now.getTime() + ACCESS_SECONDS * 1000),
			},
			{
				tokenHash: hashToken(refresh),
				kind: "refresh",
				grantId: grant.id,
				expiresAt: new Date(now.getTime() + REFRESH_DAYS * DAY),
			},
		])
		.catch((error) => {
			if (pgCode(error) === FOREIGN_KEY_VIOLATION)
				throw new OAuthError(
					"invalid_grant",
					"This connection was ended; connect again",
				);
			throw error;
		});
	return {
		access_token: access,
		token_type: "Bearer",
		expires_in: ACCESS_SECONDS,
		refresh_token: refresh,
		scope: grant.canWrite ? "read write" : "read",
	};
}

// Marks a code or refresh token used, once: of two requests racing for it,
// one wins. Using one again means someone else has it (RFC 9700 4.14), so
// the whole connection ends, the thief's new tokens with it.
async function spend<Row extends { grantId: string }>(
	db: Db,
	claim: () => Promise<Row[]>,
	find: () => Promise<{ grantId: string; usedAt: Date | null }[]>,
	what: string,
) {
	const [row] = await claim();
	if (row) return row;
	const [seen] = await find();
	if (seen?.usedAt) {
		await db.delete(oauthGrants).where(eq(oauthGrants.id, seen.grantId));
		throw new OAuthError(
			"invalid_grant",
			`This ${what} was already used, so the connection was ended; connect again`,
		);
	}
	throw new OAuthError("invalid_grant", `This ${what} is unknown or expired`);
}

// The token endpoint.
export async function exchange(
	db: Db,
	form: Record<string, string | undefined>,
	origin: string,
	now = new Date(),
) {
	const need = (key: string) => {
		const value = form[key];
		if (!value) throw new OAuthError("invalid_request", `Missing ${key}`);
		return value;
	};
	if (
		form.resource !== undefined &&
		form.resource !== endpoints(origin).resource
	)
		throw new OAuthError("invalid_request", "Unknown resource");
	// The grant, if it's this app's.
	const grantFor = async (grantId: string, clientId: string) => {
		const [grant] = await db
			.select()
			.from(oauthGrants)
			.where(
				and(eq(oauthGrants.id, grantId), eq(oauthGrants.clientId, clientId)),
			);
		if (!grant)
			throw new OAuthError(
				"invalid_grant",
				"This was issued to another app, or its connection was ended",
			);
		return grant;
	};

	if (form.grant_type === "authorization_code") {
		const clientId = need("client_id");
		const codeHash = hashToken(need("code"));
		const used = await spend(
			db,
			() =>
				db
					.update(oauthCodes)
					.set({ usedAt: now })
					.where(
						and(
							eq(oauthCodes.codeHash, codeHash),
							isNull(oauthCodes.usedAt),
							gt(oauthCodes.expiresAt, now),
						),
					)
					.returning(),
			() =>
				db.select().from(oauthCodes).where(eq(oauthCodes.codeHash, codeHash)),
			"code",
		);
		const grant = await grantFor(used.grantId, clientId);
		if (
			form.redirect_uri !== undefined &&
			form.redirect_uri !== used.redirectUri
		)
			throw new OAuthError("invalid_grant", "redirect_uri doesn't match");
		if (s256(need("code_verifier")) !== used.codeChallenge)
			throw new OAuthError("invalid_grant", "code_verifier doesn't match");
		return issue(db, grant, now);
	}

	if (form.grant_type === "refresh_token") {
		const clientId = need("client_id");
		const tokenHash = hashToken(need("refresh_token"));
		const isRefresh = and(
			eq(oauthTokens.tokenHash, tokenHash),
			eq(oauthTokens.kind, "refresh"),
		);
		const used = await spend(
			db,
			() =>
				db
					.update(oauthTokens)
					.set({ usedAt: now })
					.where(
						and(
							isRefresh,
							isNull(oauthTokens.usedAt),
							gt(oauthTokens.expiresAt, now),
						),
					)
					.returning(),
			() => db.select().from(oauthTokens).where(isRefresh),
			"refresh token",
		);
		return issue(db, await grantFor(used.grantId, clientId), now);
	}

	throw new OAuthError(
		"unsupported_grant_type",
		"Only authorization_code and refresh_token",
	);
}

// Who an access token from /mcp belongs to, or null. Notes when the
// connection was last used, at most once an hour.
export async function checkAccessToken(
	db: Db,
	token: string,
	now = new Date(),
) {
	if (!token.startsWith(PREFIX)) return null;
	const [row] = await db
		.select({
			grantId: oauthGrants.id,
			name: oauthClients.name,
			canWrite: oauthGrants.canWrite,
			lastUsedAt: oauthGrants.lastUsedAt,
		})
		.from(oauthTokens)
		.innerJoin(oauthGrants, eq(oauthGrants.id, oauthTokens.grantId))
		.innerJoin(oauthClients, eq(oauthClients.id, oauthGrants.clientId))
		.where(
			and(
				eq(oauthTokens.tokenHash, hashToken(token)),
				eq(oauthTokens.kind, "access"),
				gt(oauthTokens.expiresAt, now),
			),
		);
	if (!row) return null;
	if (!row.lastUsedAt || now.getTime() - row.lastUsedAt.getTime() > 3_600_000)
		await db
			.update(oauthGrants)
			.set({ lastUsedAt: now })
			.where(eq(oauthGrants.id, row.grantId));
	return { name: row.name, canWrite: row.canWrite };
}

// The approved apps, for Settings. One that approved but never traded its
// code still shows, so it can be removed.
export function listConnections(db: Db) {
	return db
		.select({
			id: oauthGrants.id,
			name: oauthClients.name,
			canWrite: oauthGrants.canWrite,
			createdAt: oauthGrants.createdAt,
			lastUsedAt: oauthGrants.lastUsedAt,
		})
		.from(oauthGrants)
		.innerJoin(oauthClients, eq(oauthClients.id, oauthGrants.clientId))
		.orderBy(desc(oauthGrants.createdAt));
}

// Its tokens stop working at once.
export async function disconnect(db: Db, grantId: string) {
	await db.delete(oauthGrants).where(eq(oauthGrants.id, grantId));
}
