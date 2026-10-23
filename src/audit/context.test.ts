import { describe, expect, test } from "vitest";
import type { Actor } from "#/auth/actor";
import { isWrite } from "./audited-db";
import { auditSetting, currentContext, requireActor, runAs } from "./context";

const sam: Actor = {
	kind: "staff",
	staffId: "00000000-0000-0000-0000-000000000001",
	name: "Sam",
	role: "operator",
	via: { kind: "device", passkeyId: "cred-1", name: "Warehouse iPhone" },
};
const pat: Actor = {
	kind: "legacy",
	via: { kind: "grant", grantId: "g-1", name: "Claude" },
};
const tick = () => new Promise((r) => setTimeout(r, 1));

describe("runAs", () => {
	test("is only seen inside, and not after", async () => {
		expect(currentContext()).toBeNull();
		expect(() => requireActor()).toThrow(/Signed out/);
		await runAs(sam, "op", async () => {
			await tick();
			expect(requireActor()).toBe(sam);
		});
		expect(currentContext()).toBeNull();
	});

	test("keeps concurrent requests apart across awaits", async () => {
		const seen: string[] = [];
		const run = (actor: Actor, label: string) =>
			runAs(actor, label, async () => {
				for (let i = 0; i < 3; i++) {
					await tick();
					seen.push(`${label}:${currentContext()?.operation}`);
				}
			});
		await Promise.all([run(sam, "a"), run(pat, "b")]);
		expect(
			seen.filter((s) => s.startsWith("a:")).every((s) => s === "a:a"),
		).toBe(true);
		expect(
			seen.filter((s) => s.startsWith("b:")).every((s) => s === "b:b"),
		).toBe(true);
	});

	test("ends with a thrown error too", async () => {
		await expect(
			runAs(sam, "x", async () => {
				throw new Error("boom");
			}),
		).rejects.toThrow("boom");
		expect(currentContext()).toBeNull();
	});

	test("is frozen and cuts long operations short", () => {
		runAs(sam, "x".repeat(500), () => {
			const context = currentContext();
			expect(context?.operation).toHaveLength(200);
			expect(Object.isFrozen(context)).toBe(true);
		});
	});
});

describe("auditSetting", () => {
	test("names the person and their device", () => {
		expect(
			JSON.parse(auditSetting({ actor: sam, operation: "POST /x" })),
		).toEqual({
			kind: "staff",
			operation: "POST /x",
			staff_id: "00000000-0000-0000-0000-000000000001",
			staff_name: "Sam",
			staff_role: "operator",
			via_kind: "device",
			via_id: "cred-1",
			via_name: "Warehouse iPhone",
		});
	});

	test("credits an unassigned app to no one", () => {
		expect(JSON.parse(auditSetting({ actor: pat, operation: null }))).toEqual({
			kind: "legacy",
			operation: null,
			via_kind: "grant",
			via_id: "g-1",
			via_name: "Claude",
		});
	});

	test("names the system job", () => {
		expect(
			JSON.parse(
				auditSetting({
					actor: { kind: "system", name: "cron" },
					operation: null,
				}),
			),
		).toEqual({ kind: "system", operation: null, system: "cron" });
	});
});

describe("isWrite", () => {
	test("trusts the query builder's own kind", () => {
		expect(isWrite({ sql: "select 1" }, { type: "insert" })).toBe(true);
		expect(isWrite({ sql: "insert" }, { type: "select" })).toBe(false);
	});

	test("treats any raw statement but a plain read as a write", () => {
		for (const text of [
			"select 1",
			"  SELECT x",
			"(select 1) union (select 2)",
			"show TimeZone",
			"explain select 1",
		])
			expect(isWrite({ sql: text }, undefined), text).toBe(false);
		for (const text of [
			"insert into x",
			"update x set",
			"delete from x",
			"with a as (select 1) update x set y = 1",
			"call f()",
			"truncate x",
			"do $$ begin end $$",
		])
			expect(isWrite({ sql: text }, undefined), text).toBe(true);
	});
});
