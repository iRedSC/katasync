import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, test } from "vitest";
import type { Db } from "#/db/client";
import { passkeyStaff, staff } from "#/db/identity-schema";
import * as schema from "#/db/schema";
import { callMcp } from "#/mcp/mcp.fixtures";
import { createTestDb } from "#/test/db";
import { type Actor, systemActor } from "./actor";
import { assignDevice, removeDevice, renameDevice } from "./devices";
import { admit } from "./guard";
import { standingOfSession } from "./principal";
import { createSession, SESSION_COOKIE } from "./sessions";
import {
	addStaff,
	claimOwnership,
	recoverOwner,
	removeStaff,
	restoreStaff,
	setRole,
	setupLinkForStaff,
} from "./staff";
import { addPerson, legacyDevice } from "./staff.fixtures";

let db: Db;
beforeEach(async () => {
	db = await createTestDb();
	await db
		.insert(schema.passkeys)
		.values({ id: "old-ipad", publicKey: "key", name: "Old iPad" });
});

const signedIn = async (token: string) => {
	const s = await standingOfSession(db, token);
	return s.kind === "signed-in" ? s.actor : null;
};

describe("who a session acts as", () => {
	test("a device from before staff keeps working, credited to no one", async () => {
		const token = await createSession(db, "old-ipad");
		expect(await signedIn(token)).toEqual(legacyDevice("old-ipad"));
		const admitted = await admit(
			new Request("https://k.test/_serverFn/x", {
				method: "POST",
				headers: { cookie: `${SESSION_COOKIE}=${token}` },
			}),
			db,
		);
		expect(admitted).toMatchObject({
			kind: "signed-in",
			actor: { kind: "legacy" },
		});
	});

	test("a person's device acts as them", async () => {
		const sam = await addPerson(db, "Sam", "operator", ["sam-phone"]);
		const token = await createSession(db, "sam-phone");
		expect(await signedIn(token)).toMatchObject({
			kind: "staff",
			staffId: sam.staffId,
			name: "Sam",
			role: "operator",
			via: { kind: "device", passkeyId: "sam-phone" },
		});
	});

	test("an open session sees a role change and a removal on its next request", async () => {
		const robin = await addPerson(db, "Robin", "owner", ["robin-phone"]);
		const sam = await addPerson(db, "Sam", "operator", ["sam-phone"]);
		const token = await createSession(db, "sam-phone");
		await setRole(db, robin, sam.staffId, "owner");
		expect(await signedIn(token)).toMatchObject({ role: "owner" });
		await setRole(db, robin, sam.staffId, "operator");
		expect(await signedIn(token)).toMatchObject({ role: "operator" });
		await removeStaff(db, robin, sam.staffId);
		expect(await signedIn(token)).toBeNull();
		await restoreStaff(db, robin, sam.staffId);
		expect(await signedIn(token)).toBeNull();
		expect(await signedIn(await createSession(db, "sam-phone"))).toMatchObject({
			name: "Sam",
		});
	});
});

describe("only owners administer", () => {
	test("operators, unassigned devices, and system jobs are refused on every direct call", async () => {
		const robin = await addPerson(db, "Robin", "owner", ["robin-phone"]);
		const sam = await addPerson(db, "Sam", "operator", ["sam-phone"]);
		const refused: Actor[] = [
			sam,
			legacyDevice("old-ipad"),
			systemActor("cron"),
			systemActor("webhook"),
		];
		for (const by of refused) {
			const attempts = [
				addStaff(db, by, { name: "Mallory", role: "owner" }),
				setRole(db, by, sam.staffId, "owner"),
				setRole(db, by, robin.staffId, "operator"),
				removeStaff(db, by, robin.staffId),
				restoreStaff(db, by, robin.staffId),
				setupLinkForStaff(db, by, sam.staffId),
				assignDevice(db, by, "old-ipad", sam.staffId),
				renameDevice(db, by, "robin-phone", "Mine now"),
				removeDevice(db, by, "robin-phone"),
			];
			for (const attempt of attempts)
				await expect(attempt).rejects.toThrow(/Only an owner/);
		}
		const [samRow] = await db
			.select()
			.from(staff)
			.where(eq(staff.id, sam.staffId));
		expect(samRow.role).toBe("operator");
		expect(await db.select().from(staff)).toHaveLength(2);
		expect(await db.select().from(passkeyStaff)).toHaveLength(2);
	});

	test("an owner demoted mid-session loses authority though their actor still says owner", async () => {
		const robin = await addPerson(db, "Robin", "owner", ["robin-phone"]);
		const pat = await addPerson(db, "Pat", "owner", ["pat-phone"]);
		await setRole(db, pat, robin.staffId, "operator");
		await expect(
			addStaff(db, robin, { name: "Mallory", role: "owner" }),
		).rejects.toThrow(/Only an owner/);
	});

	test("an owner gives an unassigned device to a person, once", async () => {
		const robin = await addPerson(db, "Robin", "owner", ["robin-phone"]);
		const sam = await addPerson(db, "Sam", "operator");
		await assignDevice(db, robin, "old-ipad", sam.staffId);
		const token = await createSession(db, "old-ipad");
		expect(await signedIn(token)).toMatchObject({ name: "Sam" });
		await expect(
			assignDevice(db, robin, "old-ipad", robin.staffId),
		).rejects.toThrow(/already belongs/);
	});
});

describe("there's always an owner who can sign in", () => {
	test("the last one can't step down, leave, or remove their last device", async () => {
		const robin = await addPerson(db, "Robin", "owner", ["robin-phone"]);
		await expect(setRole(db, robin, robin.staffId, "operator")).rejects.toThrow(
			/at least one owner/,
		);
		await expect(removeStaff(db, robin, robin.staffId)).rejects.toThrow(
			/at least one owner/,
		);
		await expect(removeDevice(db, robin, "robin-phone")).rejects.toThrow(
			/at least one owner/,
		);
	});

	test("of two owners demoting each other at once, one wins", async () => {
		const robin = await addPerson(db, "Robin", "owner", ["robin-phone"]);
		const pat = await addPerson(db, "Pat", "owner", ["pat-phone"]);
		const results = await Promise.allSettled([
			setRole(db, robin, pat.staffId, "operator"),
			setRole(db, pat, robin.staffId, "operator"),
		]);
		expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
		const owners = await db.select().from(staff).where(eq(staff.role, "owner"));
		expect(owners).toHaveLength(1);
	});

	test("two owners removing each other's only device at once leave one", async () => {
		const robin = await addPerson(db, "Robin", "owner", ["robin-phone"]);
		const pat = await addPerson(db, "Pat", "owner", ["pat-phone"]);
		const results = await Promise.allSettled([
			removeDevice(db, robin, "pat-phone"),
			removeDevice(db, pat, "robin-phone"),
		]);
		expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
		expect(await db.select().from(passkeyStaff)).toHaveLength(1);
	});
});

describe("the first owner", () => {
	test("is claimed by one unassigned device while there's no owner", async () => {
		const { staffId } = await claimOwnership(
			db,
			legacyDevice("old-ipad"),
			"Robin",
		);
		expect(await signedIn(await createSession(db, "old-ipad"))).toMatchObject({
			staffId,
			role: "owner",
		});
		await db
			.insert(schema.passkeys)
			.values({ id: "other", publicKey: "key", name: "Other" });
		await expect(
			claimOwnership(db, legacyDevice("other"), "Mallory"),
		).rejects.toThrow(/already an owner/);
	});

	test("can't be claimed by a named person or a system job", async () => {
		const sam = await addPerson(db, "Sam", "operator", ["sam-phone"]);
		await expect(claimOwnership(db, sam, "Sam")).rejects.toThrow(/unassigned/);
		await expect(
			claimOwnership(db, systemActor("cron"), "Cron"),
		).rejects.toThrow(/unassigned/);
	});

	test("is made or reinstated by the recovery script", async () => {
		const script = { kind: "system", name: "recovery-script" } as const;
		const made = await recoverOwner(db, script, "Robin");
		expect(made.outcome).toBe("created");
		const pat = await addPerson(db, "Pat", "owner", ["pat-phone"]);
		await removeStaff(db, pat, made.staffId);
		expect((await recoverOwner(db, script, "robin")).outcome).toBe(
			"reinstated",
		);
		expect((await recoverOwner(db, script, "Robin")).outcome).toBe("unchanged");
	});
});

describe("over MCP", () => {
	test("no tool administers staff, devices, or connections", async () => {
		const { tools } = await callMcp(db, true, "tools/list");
		const names: string[] = tools.map((t: { name: string }) => t.name);
		expect(names.length).toBeGreaterThan(0);
		for (const name of names)
			expect(name).not.toMatch(
				/staff|owner|role|passkey|device|setup_link|oauth|grant|connection|disconnect/,
			);
	});
});
