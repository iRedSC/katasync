import {
	type AuthenticationResponseJSON,
	verifyAuthenticationResponse,
} from "@simplewebauthn/server";
import { count, eq } from "drizzle-orm";
import { beforeEach, describe, expect, test, vi } from "vitest";
import type { Db } from "#/db/client";
import * as schema from "#/db/schema";
import { createTestDb } from "#/test/db";
import { safeNext } from "./client";
import { cookieValue, guard, isPublic } from "./guard";
import {
	checkSetupLink,
	consumeChallenge,
	createSession,
	createSetupLink,
	endSession,
	hashToken,
	SESSION_COOKIE,
	saveChallenge,
	sessionFor,
	useSetupLink,
} from "./sessions";
import { finishAuthentication, passkeyName } from "./webauthn";

// Checking a real signature needs a real authenticator, so the library's
// verdict is faked; what's tested is what katasync does with it.
vi.mock("@simplewebauthn/server", async (importOriginal) => ({
	...(await importOriginal<typeof import("@simplewebauthn/server")>()),
	verifyAuthenticationResponse: vi.fn(),
}));

const now = new Date("2026-10-10T12:00:00Z");
const days = (n: number) => new Date(now.getTime() + n * 86_400_000);
const minutes = (n: number) => new Date(now.getTime() + n * 60_000);

let db: Db;
beforeEach(async () => {
	db = await createTestDb();
	await db.insert(schema.passkeys).values({
		id: "phone",
		publicKey: "key",
		name: "Warehouse iPhone",
	});
});

describe("sessions", () => {
	test("last 90 days from last use and only store the token's hash", async () => {
		const token = await createSession(db, "phone", now);
		const [row] = await db.select().from(schema.sessions);
		expect(row.tokenHash).toBe(hashToken(token));
		expect(row.tokenHash).not.toBe(token);

		expect(await sessionFor(db, token, days(80))).not.toBeNull();
		// Used on day 80, so it now runs to day 170.
		expect(await sessionFor(db, token, days(169))).not.toBeNull();
		expect(await sessionFor(db, token, days(260))).toBeNull();
		expect(await sessionFor(db, "made-up", now)).toBeNull();
	});

	test("renew at most once a day", async () => {
		const token = await createSession(db, "phone", now);
		expect((await sessionFor(db, token, minutes(60)))?.renewed).toBe(false);
		expect((await sessionFor(db, token, days(2)))?.renewed).toBe(true);
		expect((await sessionFor(db, token, days(2.5)))?.renewed).toBe(false);
	});

	test("end on sign-out, and when their passkey is removed", async () => {
		const a = await createSession(db, "phone", now);
		const b = await createSession(db, "phone", now);
		await endSession(db, a);
		expect(await sessionFor(db, a, now)).toBeNull();
		expect(await sessionFor(db, b, now)).not.toBeNull();
		await db.delete(schema.passkeys).where(eq(schema.passkeys.id, "phone"));
		expect(await sessionFor(db, b, now)).toBeNull();
	});
});

test("setup links work once, until they expire", async () => {
	const token = await createSetupLink(db, 15, now);
	await checkSetupLink(db, token, minutes(10));
	await expect(checkSetupLink(db, token, minutes(16))).rejects.toThrow(
		/expired/,
	);
	await expect(checkSetupLink(db, "made-up", now)).rejects.toThrow(
		/isn't valid/,
	);
	await useSetupLink(db, token, minutes(5));
	await expect(useSetupLink(db, token, minutes(6))).rejects.toThrow(
		/already used/,
	);
	await expect(checkSetupLink(db, token, minutes(6))).rejects.toThrow(
		/already used/,
	);
});

test("a challenge answers once, within five minutes", async () => {
	await saveChallenge(db, "c1", now);
	await saveChallenge(db, "c2", now);
	expect(await consumeChallenge(db, "c1", minutes(1))).toBe(true);
	expect(await consumeChallenge(db, "c1", minutes(1))).toBe(false);
	expect(await consumeChallenge(db, "c2", minutes(6))).toBe(false);
	expect(await consumeChallenge(db, "never", now)).toBe(false);
});

test("device names are trimmed and required", () => {
	expect(passkeyName("  Office   PC ")).toBe("Office PC");
	expect(() => passkeyName(" ")).toThrow(/Name/);
});

describe("guard", () => {
	const request = (path: string, init: RequestInit = {}) =>
		new Request(`https://katasync.test${path}`, init);

	test("lets the sign-in pages and their files through", () => {
		for (const path of [
			"/login",
			"/setup",
			"/api/auth/login/options",
			"/api/cron/sync/shopify",
			"/logo.svg",
			"/assets/main-abc.js",
		])
			expect(isPublic(path)).toBe(true);
		for (const path of ["/", "/settings", "/api/other", "/_serverFn/x"])
			expect(isPublic(path)).toBe(false);
	});

	test("sends signed-out pages to sign in and refuses everything else", async () => {
		const page = await guard(
			request("/purchasing/1004?x=1", { headers: { accept: "text/html" } }),
			db,
		);
		expect(page?.status).toBe(302);
		expect(page?.headers.get("location")).toBe(
			"/login?next=%2Fpurchasing%2F1004%3Fx%3D1",
		);
		const call = await guard(request("/_serverFn/abc", { method: "POST" }), db);
		expect(call?.status).toBe(401);
	});

	test("lets a signed-in browser through", async () => {
		const token = await createSession(db, "phone");
		const req = request("/_serverFn/abc", {
			method: "POST",
			headers: { cookie: `other=1; ${SESSION_COOKIE}=${token}` },
		});
		expect(cookieValue(req, SESSION_COOKIE)).toBe(token);
		expect(await guard(req, db)).toBeNull();
	});

	test("sends a fresh cookie when it renews the session, once a day", async () => {
		// Signed in 5 days ago, so the first request renews and the next doesn't.
		const token = await createSession(db, "phone", days(-5));
		const req = request("/purchasing", {
			headers: { cookie: `${SESSION_COOKIE}=${token}` },
		});
		const cookies: string[] = [];
		expect(await guard(req, db, (c) => cookies.push(c))).toBeNull();
		expect(cookies).toEqual([
			`${SESSION_COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${90 * 86_400}`,
		]);
		expect(await guard(req, db, (c) => cookies.push(c))).toBeNull();
		expect(cookies).toHaveLength(1);
	});

	test("sends no cookie when it refuses", async () => {
		const cookies: string[] = [];
		const req = request("/purchasing", {
			method: "POST",
			headers: { cookie: `${SESSION_COOKIE}=made-up` },
		});
		expect((await guard(req, db, (c) => cookies.push(c)))?.status).toBe(401);
		expect(cookies).toEqual([]);
	});
});

describe("safeNext", () => {
	const origin = "https://katasync.test";

	test("keeps paths on this site, with their query and hash", () => {
		expect(safeNext("/purchasing/1004?x=1#top", origin)).toBe(
			"/purchasing/1004?x=1#top",
		);
		expect(safeNext("https://katasync.test/settings?a=b", origin)).toBe(
			"/settings?a=b",
		);
	});

	test("sends anything that could leave the site to the home page", () => {
		for (const next of [
			"//evil.example",
			"/\\evil.example",
			"\\\\evil.example",
			"/\t/evil.example",
			"/\n/evil.example",
			"/\r/evil.example",
			"/.//evil.example",
			"/a/..//evil.example",
			"https://evil.example/x",
			"https://katasync.test.evil.example/",
			"javascript:alert(1)",
			"",
			undefined,
			42,
		])
			expect(safeNext(next, origin), JSON.stringify(next)).toBe("/");
	});
});

describe("finishAuthentication", () => {
	const response = { id: "phone" } as AuthenticationResponseJSON;
	const verified = (newCounter: number) =>
		({
			verified: true,
			authenticationInfo: { newCounter },
		}) as Awaited<ReturnType<typeof verifyAuthenticationResponse>>;
	const counter = async () =>
		(await db.select().from(schema.passkeys))[0].counter;
	const sessionCount = async () =>
		(await db.select({ n: count() }).from(schema.sessions))[0].n;

	beforeEach(() => {
		vi.stubEnv("AUTH_ORIGIN", "https://katasync.test");
		vi.mocked(verifyAuthenticationResponse).mockReset();
	});

	test("saves the new counter and signs in", async () => {
		await db.update(schema.passkeys).set({ counter: 5 });
		vi.mocked(verifyAuthenticationResponse).mockResolvedValue(verified(6));
		const token = await finishAuthentication(db, response);
		expect(await counter()).toBe(6);
		expect(await sessionFor(db, token)).not.toBeNull();
	});

	test("refuses a sign-in when another one moved the counter meanwhile", async () => {
		await db.update(schema.passkeys).set({ counter: 5 });
		// While this sign-in is being checked, another one finishes at 7.
		vi.mocked(verifyAuthenticationResponse).mockImplementation(async () => {
			await db.update(schema.passkeys).set({ counter: 7 });
			return verified(6);
		});
		await expect(finishAuthentication(db, response)).rejects.toThrow(
			/couldn't be verified/,
		);
		expect(await counter()).toBe(7);
		expect(await sessionCount()).toBe(0);
	});

	test("keeps passkeys that always report 0 signing in", async () => {
		vi.mocked(verifyAuthenticationResponse).mockResolvedValue(verified(0));
		await finishAuthentication(db, response);
		await finishAuthentication(db, response);
		expect(await counter()).toBe(0);
		expect(await sessionCount()).toBe(2);
	});
});
