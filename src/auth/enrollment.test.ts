import {
	type RegistrationResponseJSON,
	verifyRegistrationResponse,
} from "@simplewebauthn/server";
import { beforeEach, describe, expect, test, vi } from "vitest";
import type { Db } from "#/db/client";
import { passkeyStaff } from "#/db/identity-schema";
import * as schema from "#/db/schema";
import { createTestDb } from "#/test/db";
import { checkSetupLink } from "./enrollment";
import { standingOfSession } from "./principal";
import { hashToken } from "./sessions";
import { addStaff, removeStaff } from "./staff";
import { addPerson } from "./staff.fixtures";
import {
	authenticationOptions,
	finishRegistration,
	registrationOptions,
} from "./webauthn";

vi.mock("@simplewebauthn/server", async (importOriginal) => ({
	...(await importOriginal<typeof import("@simplewebauthn/server")>()),
	verifyRegistrationResponse: vi.fn(),
}));

let db: Db;
let robin: Awaited<ReturnType<typeof addPerson>>;
beforeEach(async () => {
	vi.stubEnv("AUTH_ORIGIN", "https://katasync.test");
	vi.mocked(verifyRegistrationResponse).mockReset();
	db = await createTestDb();
	robin = await addPerson(db, "Robin", "owner", ["robin-phone"]);
});

const response = {} as RegistrationResponseJSON;

const signs = (challenge: string, credentialId: string) =>
	vi.mocked(verifyRegistrationResponse).mockImplementation(async (options) => {
		const check = options.expectedChallenge;
		if (typeof check !== "function") throw new Error("no challenge check");
		if (!(await check(challenge)))
			throw new Error(`Unexpected challenge "${challenge}"`);
		return {
			verified: true,
			registrationInfo: {
				credential: {
					id: credentialId,
					publicKey: new Uint8Array([1, 2, 3]),
					counter: 0,
					transports: [],
				},
			},
		} as unknown as Awaited<ReturnType<typeof verifyRegistrationResponse>>;
	});

const invite = async (name: string, role: "owner" | "operator" = "operator") =>
	addStaff(db, robin, { name, role });

describe("adding a device with a setup link", () => {
	test("makes a passkey for the person the link was made for, whatever the page sends", async () => {
		const { token, staffId } = await invite("Sam");
		const options = await registrationOptions(db, token);
		expect(options.user.name).toBe("Sam");
		signs(options.challenge, "sam-new");
		const session = await finishRegistration(db, {
			setupToken: token,
			name: "Sam's phone",
			response,
			staffId: robin.staffId,
			role: "owner",
		} as Parameters<typeof finishRegistration>[1]);
		expect(await standingOfSession(db, session)).toMatchObject({
			kind: "signed-in",
			actor: { kind: "staff", staffId, role: "operator" },
		});
	});

	test("works once", async () => {
		const { token } = await invite("Sam");
		const options = await registrationOptions(db, token);
		signs(options.challenge, "sam-1");
		await finishRegistration(db, { setupToken: token, name: "A", response });
		await expect(registrationOptions(db, token)).rejects.toThrow(
			/already used/,
		);
		await expect(
			finishRegistration(db, { setupToken: token, name: "B", response }),
		).rejects.toThrow(/Unexpected challenge/);
		expect(await db.select().from(passkeyStaff)).toHaveLength(2);
	});

	test("refuses a challenge from another link's ceremony and spends neither link", async () => {
		const sam = await invite("Sam");
		const pat = await invite("Pat");
		const forSam = await registrationOptions(db, sam.token);
		signs(forSam.challenge, "swapped");
		await expect(
			finishRegistration(db, { setupToken: pat.token, name: "X", response }),
		).rejects.toThrow(/Unexpected challenge/);
		await checkSetupLink(db, sam.token);
		await checkSetupLink(db, pat.token);
		expect(await db.select().from(schema.passkeys)).toHaveLength(1);
	});

	test("refuses a sign-in challenge", async () => {
		const { token } = await invite("Sam");
		const login = await authenticationOptions(db);
		signs(login.challenge, "swapped");
		await expect(
			finishRegistration(db, { setupToken: token, name: "X", response }),
		).rejects.toThrow(/Unexpected challenge/);
	});

	test("refuses links from before staff", async () => {
		const token = "old-unscoped-link";
		await db.insert(schema.setupLinks).values({
			tokenHash: hashToken(token),
			expiresAt: new Date(Date.now() + 60_000),
		});
		await expect(registrationOptions(db, token)).rejects.toThrow(
			/before staff/,
		);
	});

	test("refuses a removed person's link, even mid-ceremony", async () => {
		const { token, staffId } = await invite("Sam");
		const options = await registrationOptions(db, token);
		await removeStaff(db, robin, staffId);
		signs(options.challenge, "late");
		await expect(
			finishRegistration(db, { setupToken: token, name: "X", response }),
		).rejects.toThrow(/removed/);
		expect(await db.select().from(schema.passkeys)).toHaveLength(1);
		await expect(registrationOptions(db, token)).rejects.toThrow(/removed/);
	});

	test("keeps each person's passkeys apart on a shared device", async () => {
		await addPerson(db, "Pat", "operator", ["pat-phone"]);
		const { token } = await invite("Sam");
		const options = await registrationOptions(db, token);
		expect(options.excludeCredentials).toEqual([]);
		const again = await registrationOptions(
			db,
			(await addStaff(db, robin, { name: "Lee", role: "operator" })).token,
		);
		expect(again.user.id).not.toBe(options.user.id);
	});
});
