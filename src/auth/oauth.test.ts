import { createHash } from "node:crypto";
import { beforeEach, describe, expect, test } from "vitest";
import type { Db } from "#/db/client";
import * as schema from "#/db/schema";
import { createTestDb } from "#/test/db";
import {
	answerAuthorize,
	checkAccessToken,
	checkAuthorize,
	disconnect,
	exchange,
	listConnections,
	OAuthError,
	registerClient,
} from "./oauth";

const ORIGIN = "https://katasync.test";
const CALLBACK = "https://claude.ai/api/mcp/auth_callback";
const now = new Date("2026-10-10T12:00:00Z");
const minutes = (n: number) => new Date(now.getTime() + n * 60_000);
const days = (n: number) => new Date(now.getTime() + n * 86_400_000);

const verifier = "a-long-random-verifier-the-app-keeps-to-itself-0123456789";
const challenge = createHash("sha256").update(verifier).digest("base64url");

let db: Db;
let clientId: string;
beforeEach(async () => {
	db = await createTestDb();
	({ client_id: clientId } = await registerClient(
		db,
		{ client_name: " Claude ", redirect_uris: [CALLBACK] },
		now,
	));
});

const request = (over: Record<string, string | undefined> = {}) => ({
	response_type: "code",
	client_id: clientId,
	redirect_uri: CALLBACK,
	code_challenge: challenge,
	code_challenge_method: "S256",
	state: "xyz",
	resource: `${ORIGIN}/mcp`,
	...over,
});

// Approves and returns the code from where the browser is sent.
async function approve(canWrite = true, at = now) {
	const r = await answerAuthorize(
		db,
		request(),
		ORIGIN,
		{ approve: true, canWrite },
		at,
	);
	if (r.kind !== "redirect") throw new Error(r.message);
	const url = new URL(r.url);
	expect(url.origin + url.pathname).toBe(CALLBACK);
	expect(url.searchParams.get("state")).toBe("xyz");
	expect(url.searchParams.get("iss")).toBe(ORIGIN);
	return url.searchParams.get("code") ?? "";
}

const trade = (code: string, at = now, over: Record<string, string> = {}) =>
	exchange(
		db,
		{
			grant_type: "authorization_code",
			code,
			client_id: clientId,
			redirect_uri: CALLBACK,
			code_verifier: verifier,
			...over,
		},
		ORIGIN,
		at,
	);

describe("registering", () => {
	test("keeps https and loopback addresses only", async () => {
		await expect(
			registerClient(db, { redirect_uris: ["http://evil.example/cb"] }),
		).rejects.toThrow(OAuthError);
		await expect(
			registerClient(db, { redirect_uris: ["claude://callback"] }),
		).rejects.toThrow(OAuthError);
		await expect(registerClient(db, { redirect_uris: [] })).rejects.toThrow(
			OAuthError,
		);
		// An empty address first can't hide a bad one after it.
		await expect(
			registerClient(db, { redirect_uris: ["", "javascript:alert(1)"] }),
		).rejects.toThrow(OAuthError);
		const local = await registerClient(db, {
			redirect_uris: ["http://localhost:33418/callback"],
		});
		expect(local.client_name).toBe("An unnamed app");
		expect(local.token_endpoint_auth_method).toBe("none");
	});

	test("clears out apps nobody approved after a day", async () => {
		await approve();
		const { client_id: unused } = await registerClient(
			db,
			{ redirect_uris: [CALLBACK] },
			now,
		);
		await registerClient(db, { redirect_uris: [CALLBACK] }, days(2));
		const ids = (await db.select().from(schema.oauthClients)).map((c) => c.id);
		expect(ids).toContain(clientId);
		expect(ids).not.toContain(unused);
	});
});

describe("approving", () => {
	test("never sends the browser to a stored address that isn't safe", async () => {
		// Registered before the check was tightened.
		const [bad] = await db
			.insert(schema.oauthClients)
			.values({
				id: "legacy",
				name: "Old app",
				redirectUris: ["javascript:alert(1)"],
				createdAt: now,
			})
			.returning();
		const over = { client_id: bad.id, redirect_uri: "javascript:alert(1)" };
		// A request that would otherwise be refused back to the app.
		expect(
			(
				await checkAuthorize(
					db,
					request({ ...over, response_type: "token" }),
					ORIGIN,
				)
			).kind,
		).toBe("invalid");
		for (const approve of [true, false])
			expect(
				(
					await answerAuthorize(db, request(over), ORIGIN, {
						approve,
						canWrite: true,
					})
				).kind,
			).toBe("invalid");
	});

	test("asks with the app's name and where it goes back to", async () => {
		expect(await checkAuthorize(db, request(), ORIGIN)).toEqual({
			kind: "ask",
			clientName: "Claude",
			redirectHost: "claude.ai",
		});
	});

	test("won't send the browser to an unknown app or address", async () => {
		for (const over of [
			{ client_id: "made-up" },
			{ redirect_uri: "https://evil.example/cb" },
		]) {
			expect((await checkAuthorize(db, request(over), ORIGIN)).kind).toBe(
				"invalid",
			);
			const r = await answerAuthorize(db, request(over), ORIGIN, {
				approve: true,
				canWrite: true,
			});
			expect(r.kind).toBe("invalid");
		}
		expect(await db.select().from(schema.oauthGrants)).toHaveLength(0);
	});

	test("tells the app when it asked without PKCE or for another resource", async () => {
		for (const [over, error] of [
			[{ code_challenge: undefined }, "invalid_request"],
			[{ code_challenge_method: "plain" }, "invalid_request"],
			[{ response_type: "token" }, "unsupported_response_type"],
			[{ resource: "https://elsewhere.example/mcp" }, "invalid_target"],
		] as const) {
			const r = await checkAuthorize(db, request(over), ORIGIN);
			if (r.kind !== "refused") throw new Error(r.kind);
			expect(new URL(r.redirect).searchParams.get("error")).toBe(error);
		}
	});

	test("denying tells the app and makes nothing", async () => {
		const r = await answerAuthorize(db, request(), ORIGIN, { approve: false });
		if (r.kind !== "redirect") throw new Error(r.message);
		expect(new URL(r.url).searchParams.get("error")).toBe("access_denied");
		expect(await db.select().from(schema.oauthGrants)).toHaveLength(0);
	});
});

describe("tokens", () => {
	test("a code works once, with the right verifier, within minutes", async () => {
		const code = await approve();
		await expect(
			trade(code, now, { code_verifier: "wrong" }),
		).rejects.toMatchObject({ code: "invalid_grant" });
		// The failed try used it up.
		await expect(trade(code)).rejects.toMatchObject({ code: "invalid_grant" });

		const late = await approve();
		await expect(trade(late, minutes(6))).rejects.toMatchObject({
			code: "invalid_grant",
		});
	});

	test("a code used twice ends the connection it made", async () => {
		const code = await approve();
		const { access_token } = await trade(code);
		await expect(trade(code)).rejects.toMatchObject({ code: "invalid_grant" });
		expect(await checkAccessToken(db, access_token)).toBeNull();
		expect(await listConnections(db)).toHaveLength(0);
	});

	test("a code is only for the app it was made for", async () => {
		const code = await approve();
		await expect(
			trade(code, now, { client_id: "someone-else" }),
		).rejects.toMatchObject({ code: "invalid_grant" });
	});

	test("access lasts an hour and carries read only", async () => {
		const { access_token, scope } = await trade(await approve(false));
		expect(scope).toBe("read");
		expect(await checkAccessToken(db, access_token, minutes(59))).toEqual({
			name: "Claude",
			canWrite: false,
		});
		expect(await checkAccessToken(db, access_token, minutes(61))).toBeNull();
		expect(await checkAccessToken(db, "ks_made-up")).toBeNull();
	});

	const refresh = (token: string, at = minutes(90)) =>
		exchange(
			db,
			{
				grant_type: "refresh_token",
				refresh_token: token,
				client_id: clientId,
			},
			ORIGIN,
			at,
		);

	test("refreshing gives a new pair, once", async () => {
		const first = await trade(await approve());
		// A refresh token can't call /mcp, nor an access token refresh.
		expect(await checkAccessToken(db, first.refresh_token, now)).toBeNull();
		await expect(refresh(first.access_token)).rejects.toMatchObject({
			code: "invalid_grant",
		});
		const second = await refresh(first.refresh_token);
		expect(
			await checkAccessToken(db, second.access_token, minutes(90)),
		).not.toBeNull();
		await expect(refresh(second.refresh_token, days(91))).rejects.toMatchObject(
			{
				code: "invalid_grant",
			},
		);
	});

	test("a stolen refresh token, used first, is stopped when the app refreshes", async () => {
		const app = await trade(await approve());
		const thief = await refresh(app.refresh_token, minutes(30));
		await expect(refresh(app.refresh_token, minutes(61))).rejects.toThrow(
			/already used/,
		);
		expect(
			await checkAccessToken(db, thief.access_token, minutes(62)),
		).toBeNull();
		await expect(
			refresh(thief.refresh_token, minutes(63)),
		).rejects.toMatchObject({
			code: "invalid_grant",
		});
		expect(await listConnections(db)).toHaveLength(0);
	});

	test("of two refreshes racing, at most one wins and the connection ends", async () => {
		const app = await trade(await approve());
		const results = await Promise.allSettled([
			refresh(app.refresh_token),
			refresh(app.refresh_token),
		]);
		for (const r of results)
			if (r.status === "rejected")
				expect(r.reason).toMatchObject({ code: "invalid_grant" });
			else
				expect(
					await checkAccessToken(db, r.value.access_token, minutes(90)),
				).toBeNull();
		expect(results.some((r) => r.status === "rejected")).toBe(true);
		expect(await listConnections(db)).toHaveLength(0);
	});

	test("only hashes are kept", async () => {
		const { access_token, refresh_token } = await trade(await approve());
		const kept = (await db.select().from(schema.oauthTokens)).map(
			(t) => t.tokenHash,
		);
		expect(kept).toHaveLength(2);
		expect(kept).not.toContain(access_token);
		expect(kept).not.toContain(refresh_token);
	});

	test("disconnecting stops its tokens at once", async () => {
		const { access_token } = await trade(await approve());
		await checkAccessToken(db, access_token, minutes(1));
		const [app] = await listConnections(db);
		expect(app).toMatchObject({ name: "Claude", canWrite: true });
		expect(app.lastUsedAt).toEqual(minutes(1));
		await disconnect(db, app.id);
		expect(await checkAccessToken(db, access_token, minutes(2))).toBeNull();
		expect(await listConnections(db)).toHaveLength(0);
	});
});
