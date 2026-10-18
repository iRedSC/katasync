import { beforeEach, describe, expect, test } from "vitest";
import type { Db } from "#/db/client";
import { callMcp, freshDb } from "./mcp.fixtures";
import { READ_TOOLS } from "./server";

let db: Db;
beforeEach(async () => {
	({ db } = await freshDb());
});

describe("over MCP", () => {
	let canWrite = true;
	beforeEach(() => {
		canWrite = true;
	});
	const call = (method: string, params: Record<string, unknown> = {}) =>
		callMcp(db, canWrite, method, params);

	test("lists its tools, marking which only read", async () => {
		const { tools } = await call("tools/list");
		const byName = new Map(
			tools.map((t: { name: string; annotations: object }) => [
				t.name,
				t.annotations,
			]),
		);
		expect(byName.get("query")).toMatchObject({ readOnlyHint: true });
		expect(byName.get("set_draft_po_lines")).toMatchObject({
			readOnlyHint: false,
		});
		expect(byName.get("delete_draft_po")).toMatchObject({
			destructiveHint: true,
		});
		expect(byName.has("send_purchase_order")).toBe(false);
		// /mcp logs every tool not listed as reading; the list must be right.
		const reading = tools
			.filter(
				(t: { annotations: { readOnlyHint?: boolean } }) =>
					t.annotations.readOnlyHint,
			)
			.map((t: { name: string }) => t.name)
			.sort();
		expect(reading).toEqual([...READ_TOOLS].sort());
	});

	test("a read-only token gets only the reading tools", async () => {
		canWrite = false;
		const { tools } = await call("tools/list");
		expect(tools.map((t: { name: string }) => t.name).sort()).toEqual(
			[...READ_TOOLS].sort(),
		);
		const tried = await call("tools/call", {
			name: "record_count",
			arguments: { sku: "BLADE", counted: 1 },
		});
		expect(tried.isError).toBe(true);
	});
});
