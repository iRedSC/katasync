import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { beforeEach, expect, test, vi } from "vitest";
import type { Agent } from "#/ai/harness";
import type { Db } from "#/db/client";
import {
	marketEmailAttachments,
	marketEmails,
	orderLines,
	orders,
	products,
	stores,
} from "#/db/schema";
import type { InboxMessage } from "#/purchasing/inbox/graph";
import { createTestDb } from "#/test/db";
import { mailOrders } from "./mail-orders";
import {
	ingestMarketMail,
	marketMailPage,
	moveTo,
	setDone,
	setImportant,
} from "./market-mail";
import {
	finishVoicemail,
	retryVoicemail,
	triageVoicemails,
	voicemailAgent,
} from "./voicemail";
import type { VoicemailDecision } from "./voicemail-model";

let db: Db;
beforeEach(async () => {
	db = await createTestDb();
});

const source: InboxMessage = {
	graphId: "ooma-1",
	messageId: "<voicemail-1@ooma.com>",
	fromAddress: "no_reply@ooma.com",
	fromName: "Ooma",
	subject: "New voicemail from Jane",
	recipients: ["marketplaces@example.com"],
	receivedAt: new Date(),
};
const body =
	"Caller Name\nJane Doe\nCaller Number\n(800) 555-1234\nDuration\n00:00:30\nVoicemail Preview:\nPlease call me about my missing order.\nTo listen to this voicemail, click on the attachment in this email.";
const audio = {
	filename: "voicemail.mp3",
	contentType: "application/octet-stream",
	size: 3,
	data: Buffer.from("mp3"),
};
const ready: VoicemailDecision = {
	state: "ready",
	title: "Call Jane about a missing order",
	summary:
		"Jane asks for a callback about a missing order. No order number given.",
	level: "important",
	orderIds: [],
	productIds: [],
};

function runner(decision: VoicemailDecision) {
	return vi.fn(async (agent: Agent<VoicemailDecision>) => {
		agent.output.assert(decision);
		return decision;
	});
}

async function ingest(text = body, attachments = [audio]) {
	await ingestMarketMail(db, [source], async () => ({
		body: text,
		attachments,
	}));
	const [email] = await db.select().from(marketEmails);
	return email;
}

test("deduplicates delivery, keeps recording bytes, and separates the voicemail folder", async () => {
	const email = await ingest();
	await ingest();
	expect(await db.select().from(marketEmails)).toHaveLength(1);
	const [file] = await db.select().from(marketEmailAttachments);
	expect(file.data).toEqual(Buffer.from("mp3"));
	const page = await marketMailPage(db, "voicemails", null);
	expect(page.emails.map((row) => row.id)).toEqual([email.id]);
	expect(page.counts.voicemails).toBe(1);
	expect(page.counts.updates).toBe(0);
	expect((await marketMailPage(db, "updates", null)).emails).toEqual([]);
	expect(
		(await marketMailPage(db, "voicemails", "amazon")).emails,
	).toHaveLength(1);
	await expect(moveTo(db, email.id, "orders")).rejects.toThrow(
		"Voicemails stay in Voicemails",
	);
});

test("assembles a request, preserves source text, and applies importance", async () => {
	await ingest();
	const run = runner(ready);
	expect(await triageVoicemails(db, { run, configured: true })).toEqual({
		processed: 1,
	});
	const [email] = await db.select().from(marketEmails);
	expect(email.voicemail).toEqual(ready);
	expect(email.body).toBe(body);
	expect(email.important).toBe(true);
	expect(email.doneAt).toBeNull();
	expect((await marketMailPage(db, "important", null)).emails).toHaveLength(1);
	await triageVoicemails(db, { run, configured: true });
	expect(run).toHaveBeenCalledTimes(1);
});

test("critical requests are important too", async () => {
	await ingest();
	await triageVoicemails(db, {
		run: runner({ ...ready, level: "critical" }),
		configured: true,
	});
	const [email] = await db.select().from(marketEmails);
	expect(email.critical).toBe(true);
	expect(email.important).toBe(true);
});

test("bad voicemails are recoverable in Done with their recording", async () => {
	const email = await ingest();
	await triageVoicemails(db, {
		run: runner({ state: "dismissed", reason: "Unrelated sales pitch" }),
		configured: true,
	});
	expect((await marketMailPage(db, "voicemails", null)).emails).toHaveLength(0);
	const done = await marketMailPage(db, "done", null);
	expect(done.emails[0].voicemail).toEqual({
		state: "dismissed",
		reason: "Unrelated sales pitch",
	});
	expect(done.emails[0].attachments[0].kept).toBe(true);
	await setDone(db, email.id, false);
	const restored = await marketMailPage(db, "voicemails", null);
	expect(restored.emails[0].voicemail?.state).toBe("review");
});

test("missing transcripts, missing recordings, and AI failure stay visible for review", async () => {
	const email = await ingest("No preview");
	const run = runner(ready);
	await triageVoicemails(db, { run, configured: true });
	expect(run).not.toHaveBeenCalled();
	expect(
		(await marketMailPage(db, "voicemails", null)).emails[0].voicemail?.state,
	).toBe("review");
	await db
		.update(marketEmails)
		.set({ body })
		.where(eq(marketEmails.id, email.id));
	await db.update(marketEmailAttachments).set({ data: null });
	await retryVoicemail(db, email.id);
	await triageVoicemails(db, { run, configured: true });
	expect(run).not.toHaveBeenCalled();
	await db.update(marketEmailAttachments).set({ data: Buffer.from("mp3") });
	await retryVoicemail(db, email.id);
	const failed = vi.fn(async () => {
		throw new Error("Proxy unavailable");
	});
	await triageVoicemails(db, { run: failed, configured: true });
	const [row] = await db.select().from(marketEmails);
	expect(row.voicemail).toEqual({
		state: "review",
		reason: "Proxy unavailable",
	});
	expect(row.doneAt).toBeNull();
});

test("retries only open review items, never finished or already queued items", async () => {
	const email = await ingest();
	await expect(retryVoicemail(db, email.id)).rejects.toThrow(
		"Only an open voicemail",
	);
	await db
		.update(marketEmails)
		.set({ voicemail: { state: "review", reason: "Try later" } });
	await retryVoicemail(db, email.id);
	await expect(retryVoicemail(db, email.id)).rejects.toThrow();
	await db.update(marketEmails).set({
		voicemail: { state: "review", reason: "Try later" },
		doneAt: new Date(),
	});
	await expect(retryVoicemail(db, email.id)).rejects.toThrow();
});

test("the screenshot's one-word preview stays for listening, not automatic dismissal", async () => {
	await ingest(body.replace("Please call me about my missing order.", "You"));
	const run = runner({ state: "dismissed", reason: "No request" });
	await triageVoicemails(db, { run, configured: true });
	expect(run).not.toHaveBeenCalled();
	const [email] = await db.select().from(marketEmails);
	expect(email.voicemail?.state).toBe("review");
	expect(email.doneAt).toBeNull();
});

test("unconfigured AI is visible and queued work survives an exhausted run budget", async () => {
	await ingest();
	const run = runner(ready);
	expect(
		await triageVoicemails(db, { run, configured: true, deadline: Date.now() }),
	).toEqual({ processed: 0 });
	expect((await db.select().from(marketEmails))[0].voicemail?.state).toBe(
		"pending",
	);
	await triageVoicemails(db, { run, configured: false });
	expect(run).not.toHaveBeenCalled();
	expect((await db.select().from(marketEmails))[0].voicemail?.state).toBe(
		"review",
	);
});

test("a fresh claim is not stolen, and expired claims recover after a crash", async () => {
	const email = await ingest();
	const claim = {
		state: "processing",
		token: randomUUID(),
		startedAt: new Date().toISOString(),
	} as const;
	await db.update(marketEmails).set({ voicemail: claim });
	const run = runner(ready);
	expect(await triageVoicemails(db, { run, configured: true })).toEqual({
		processed: 0,
	});
	await db.update(marketEmails).set({
		voicemail: {
			...claim,
			startedAt: new Date(Date.now() - 11 * 60_000).toISOString(),
		},
	});
	expect(await triageVoicemails(db, { run, configured: true })).toEqual({
		processed: 1,
	});
	expect(
		await finishVoicemail(db, email.id, claim, {
			state: "dismissed",
			reason: "Stale result",
		}),
	).toBe(false);
	expect((await db.select().from(marketEmails))[0].voicemail).toEqual(ready);
});

test("duplicate completions and out-of-order workers cannot overwrite a result", async () => {
	const email = await ingest();
	const claim = {
		state: "processing",
		token: randomUUID(),
		startedAt: new Date().toISOString(),
	} as const;
	await db.update(marketEmails).set({ voicemail: claim });
	expect(await finishVoicemail(db, email.id, claim, ready)).toBe(true);
	expect(
		await finishVoicemail(db, email.id, claim, {
			state: "dismissed",
			reason: "Duplicate",
		}),
	).toBe(false);
	expect((await db.select().from(marketEmails))[0].voicemail).toEqual(ready);
});

test("AI completion preserves a staff member's priority choice", async () => {
	const email = await ingest();
	const claim = {
		state: "processing",
		token: randomUUID(),
		startedAt: new Date().toISOString(),
	} as const;
	await db.update(marketEmails).set({ voicemail: claim });
	await setImportant(db, email.id, "normal");
	await finishVoicemail(db, email.id, claim, ready);
	expect((await db.select().from(marketEmails))[0].important).toBe(false);
});

test("only IDs returned by the read-only context tool can be embedded", async () => {
	const [product] = await db
		.insert(products)
		.values({ sku: "FLAT-12", name: "12 inch flat box", kind: "simple" })
		.returning();
	const { agent, validate } = voicemailAgent(db);
	expect(() => validate({ ...ready, productIds: [product.id] })).toThrow(
		"did not look up",
	);
	const tool = agent.tools?.[0];
	if (!tool) throw new Error("Missing context tool");
	await tool.run({ query: "FLAT-12" });
	expect(validate({ ...ready, productIds: [product.id] })).toEqual({
		...ready,
		productIds: [product.id],
	});
	expect(() => validate({ ...ready, orderIds: [999999] })).toThrow(
		"did not look up",
	);
});

test("database constraints reject an invalid persisted state", async () => {
	const email = await ingest();
	await expect(
		db.execute(
			sql`update market_emails set voicemail = '{"state":"ready"}'::jsonb where id = ${email.id}`,
		),
	).rejects.toThrow();
	await expect(
		db.execute(
			sql`update market_emails set voicemail = '{"state":"other"}'::jsonb where id = ${email.id}`,
		),
	).rejects.toThrow();
});

test("the agent cannot embed a made-up product ID", async () => {
	await ingest();
	await triageVoicemails(db, {
		run: runner({ ...ready, productIds: [999999] }),
		configured: true,
	});
	const [email] = await db.select().from(marketEmails);
	expect(email.voicemail?.state).toBe("review");
	expect(email.doneAt).toBeNull();
});

test("looked-up orders embed the existing order card, not transcript guesses", async () => {
	const email = await ingest();
	const [store] = await db
		.insert(stores)
		.values({ channel: "shopify", name: "Shopify" })
		.returning();
	const [order] = await db
		.insert(orders)
		.values({
			storeId: store.id,
			externalId: "gid://shopify/Order/5754",
			name: "#5754",
			customerName: "Jane Doe",
			placedAt: new Date(),
			sourceUpdatedAt: new Date(),
			fulfillmentStatus: "UNFULFILLED",
			total: 40,
		})
		.returning();
	await db.insert(orderLines).values({
		orderId: order.id,
		externalId: "line-1",
		title: "Flat box",
		quantity: 1,
		unitPrice: 40,
	});
	const { agent, validate } = voicemailAgent(db);
	const tool = agent.tools?.[0];
	if (!tool) throw new Error("Missing context tool");
	await tool.run({ query: "#5754" });
	const decision = validate({ ...ready, orderIds: [order.id] });
	await db
		.update(marketEmails)
		.set({ voicemail: decision })
		.where(eq(marketEmails.id, email.id));
	const found = await mailOrders(db, email.id);
	expect(found.orders.map((item) => item.id)).toEqual([order.id]);
	expect(found.orders[0].lines[0].title).toBe("Flat box");
});

test("long dismissal reasons remain valid when restored", async () => {
	const email = await ingest();
	await triageVoicemails(db, {
		run: runner({ state: "dismissed", reason: "x".repeat(500) }),
		configured: true,
	});
	await setDone(db, email.id, false);
	expect(
		(await marketMailPage(db, "voicemails", null)).emails[0].voicemail?.state,
	).toBe("review");
});
