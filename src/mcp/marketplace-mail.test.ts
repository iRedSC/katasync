import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { Db } from "#/db/client";
import { callTool, freshDb } from "./mcp.fixtures";

// The marketplaces mailbox over MCP, with Microsoft Graph faked: each tool
// reads only its own mailbox.

let db: Db;
let asked: string[];

const message = {
	id: "g1",
	internetMessageId: "<1@amazon.com>",
	receivedDateTime: "2026-10-21T15:00:00Z",
	subject: "Policy warning: listing removed",
	from: {
		emailAddress: { address: "seller-notification@amazon.com", name: "Amazon" },
	},
	toRecipients: [
		{ emailAddress: { address: "marketplaces@eastcoastdrywall.com" } },
	],
	isDraft: false,
};

beforeEach(async () => {
	({ db } = await freshDb());
	asked = [];
	vi.stubEnv("MS_GRAPH_TENANT_ID", "tenant");
	vi.stubEnv("MS_GRAPH_CLIENT_ID", "client");
	vi.stubEnv("MS_GRAPH_CLIENT_SECRET", "secret");
	vi.stubEnv("PO_INBOX", "purchasing@eastcoastdrywall.com");
	vi.stubEnv("MARKETPLACE_INBOX", "Marketplaces@EastCoastDrywall.com");
	vi.stubGlobal("fetch", async (url: string) => {
		asked.push(url);
		if (url.includes("login.microsoftonline.com"))
			return Response.json({ access_token: "token", expires_in: 3600 });
		if (url.includes("/attachments")) return Response.json({ value: [] });
		if (url.includes("$select=body"))
			return Response.json({ body: { content: "ASIN B01 was removed." } });
		if (url.includes("/messages/g1")) return Response.json(message);
		return Response.json({ value: [message] });
	});
});

afterEach(() => {
	vi.unstubAllEnvs();
	vi.unstubAllGlobals();
});

const graphCalls = () => asked.filter((u) => u.includes("graph.microsoft.com"));

describe("marketplaces mailbox", () => {
	test("search reads the marketplaces mailbox, for read-only apps too", async () => {
		const { isError, data } = await callTool(
			db,
			false,
			"search_marketplace_mail",
			{ words: "policy" },
		);
		expect(isError).toBe(false);
		expect(data).toEqual([
			{
				graph_id: "g1",
				from: "Amazon <seller-notification@amazon.com>",
				to: ["marketplaces@eastcoastdrywall.com"],
				subject: "Policy warning: listing removed",
				receivedAt: "2026-10-21T15:00:00.000Z",
			},
		]);
		expect(graphCalls()).not.toHaveLength(0);
		for (const url of graphCalls())
			expect(url).toContain("/users/marketplaces%40eastcoastdrywall.com/");
	});

	test("reads one email's body", async () => {
		const { data } = await callTool(db, false, "read_marketplace_email", {
			graph_id: "g1",
		});
		expect(data).toMatchObject({
			subject: "Policy warning: listing removed",
			body: "ASIN B01 was removed.",
			attachments: [],
		});
		for (const url of graphCalls())
			expect(url).toContain("/users/marketplaces%40eastcoastdrywall.com/");
	});

	test("the purchasing tools still read only purchasing", async () => {
		await callTool(db, false, "search_inbox", { words: "invoice" });
		expect(graphCalls()).not.toHaveLength(0);
		for (const url of graphCalls())
			expect(url).toContain("/users/purchasing%40eastcoastdrywall.com/");
	});

	test("without MARKETPLACE_INBOX it says what to set", async () => {
		vi.stubEnv("MARKETPLACE_INBOX", "");
		const { isError, data } = await callTool(
			db,
			false,
			"search_marketplace_mail",
			{},
		);
		expect(isError).toBe(true);
		expect(data).toContain("set MARKETPLACE_INBOX");
		expect(graphCalls()).toEqual([]);
	});
});
