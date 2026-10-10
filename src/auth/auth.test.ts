import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, test } from "vitest";
import type { Db } from "#/db/client";
import * as schema from "#/db/schema";
import { createTestDb } from "#/test/db";
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
import { passkeyName } from "./webauthn";

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
});
