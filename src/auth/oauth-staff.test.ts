import { createHash } from "node:crypto";
import { beforeEach, describe, expect, test } from "vitest";
import type { Db } from "#/db/client";
import { oauthGrantStaff } from "#/db/identity-schema";
import * as schema from "#/db/schema";
import { createTestDb } from "#/test/db";
import { type Actor, systemActor } from "./actor";
import {
	answerAuthorize,
	checkAccessToken,
	checkAuthorize,
	disconnect,
	exchange,
	listConnections,
	registerClient,
} from "./oauth";
import { removeStaff, restoreStaff, setRole } from "./staff";
import { addPerson, legacyDevice } from "./staff.fixtures";

const ORIGIN = "https://katasync.test";
const CALLBACK = "https://claude.ai/api/mcp/auth_callback";
const verifier = "a-long-random-verifier-the-app-keeps-to-itself-0123456789";
const challenge = createHash("sha256").update(verifier).digest("base64url");

let db: Db;
let clientId: string;
beforeEach(async () => {
	db = await createTestDb();
	({ client_id: clientId } = await registerClient(db, {
		client_name: "Claude",
		redirect_uris: [CALLBACK],
	}));
});

const params = () => ({
	response_type: "code",
	client_id: clientId,
	redirect_uri: CALLBACK,
	code_challenge: challenge,
	code_challenge_method: "S256",
	resource: `${ORIGIN}/mcp`,
});

async function connect(by: Actor) {
	const r = await answerAuthorize(db, by, params(), ORIGIN, {
		approve: true,
		canWrite: true,
	});
	if (r.kind !== "redirect") throw new Error(r.message);
	const code = new URL(r.url).searchParams.get("code") ?? "";
	const { access_token } = await exchange(
		db,
		{
			grant_type: "authorization_code",
			code,
			client_id: clientId,
			redirect_uri: CALLBACK,
			code_verifier: verifier,
		},
		ORIGIN,
	);
	return access_token;
}

describe("connected apps", () => {
	test("act for the owner who approved them, while they're an owner", async () => {
		const robin = await addPerson(db, "Robin", "owner", ["robin-phone"]);
		const pat = await addPerson(db, "Pat", "owner", ["pat-phone"]);
		const token = await connect(robin);
		expect(await checkAccessToken(db, token)).toMatchObject({
			canWrite: true,
			actor: {
				kind: "staff",
				staffId: robin.staffId,
				via: { kind: "grant", name: "Claude" },
			},
		});
		expect(await listConnections(db)).toMatchObject([{ approvedBy: "Robin" }]);
		await setRole(db, pat, robin.staffId, "operator");
		expect(await checkAccessToken(db, token)).toBeNull();
		await setRole(db, pat, robin.staffId, "owner");
		expect(await checkAccessToken(db, token)).not.toBeNull();
		await removeStaff(db, pat, robin.staffId);
		expect(await checkAccessToken(db, token)).toBeNull();
		await restoreStaff(db, pat, robin.staffId);
		expect(await checkAccessToken(db, token)).not.toBeNull();
	});

	test("can't be approved, listed as approved, or disconnected by anyone else", async () => {
		const robin = await addPerson(db, "Robin", "owner", ["robin-phone"]);
		const sam = await addPerson(db, "Sam", "operator", ["sam-phone"]);
		for (const by of [sam, legacyDevice("sam-phone"), systemActor("cron")]) {
			expect(await checkAuthorize(db, by, params(), ORIGIN)).toMatchObject({
				kind: "invalid",
			});
			expect(
				await answerAuthorize(db, by, params(), ORIGIN, {
					approve: true,
					canWrite: true,
				}),
			).toMatchObject({ kind: "invalid" });
		}
		expect(await db.select().from(schema.oauthGrants)).toHaveLength(0);
		const token = await connect(robin);
		const [app] = await listConnections(db);
		await expect(disconnect(db, sam, app.id)).rejects.toThrow(/Only an owner/);
		expect(await checkAccessToken(db, token)).not.toBeNull();
	});

	test("from before staff keep working, credited to no one", async () => {
		const token = await connect(systemActor("dev-server"));
		expect(await db.select().from(oauthGrantStaff)).toHaveLength(0);
		expect(await checkAccessToken(db, token)).toMatchObject({
			actor: { kind: "legacy", via: { kind: "grant", name: "Claude" } },
		});
	});
});
