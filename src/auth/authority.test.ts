import { describe, expect, test } from "vitest";
import { describeActor, mayAdminister, systemActor } from "./actor";
import { leavesUsableOwner } from "./authority";

describe("leavesUsableOwner", () => {
	const two = [
		{ staffId: "a", passkeyIds: ["a1"] },
		{ staffId: "b", passkeyIds: ["b1", "b2"] },
	];
	const one = [{ staffId: "a", passkeyIds: ["a1"] }];

	test("an owner may step down while another can sign in", () => {
		expect(leavesUsableOwner(two, { kind: "owner-leaves", staffId: "a" })).toBe(
			true,
		);
	});

	test("the last owner who can sign in can't leave or lose their last device", () => {
		expect(leavesUsableOwner(one, { kind: "owner-leaves", staffId: "a" })).toBe(
			false,
		);
		expect(
			leavesUsableOwner(one, { kind: "device-removed", passkeyId: "a1" }),
		).toBe(false);
	});

	test("an owner with another device, or someone else's device, is fine", () => {
		expect(
			leavesUsableOwner(two, { kind: "device-removed", passkeyId: "b1" }),
		).toBe(true);
		expect(
			leavesUsableOwner(one, { kind: "device-removed", passkeyId: "x" }),
		).toBe(true);
	});

	test("an owner without devices counts for nothing", () => {
		const unenrolled = [
			{ staffId: "a", passkeyIds: [] },
			{ staffId: "b", passkeyIds: ["b1"] },
		];
		expect(
			leavesUsableOwner(unenrolled, { kind: "owner-leaves", staffId: "b" }),
		).toBe(false);
		expect(
			leavesUsableOwner(unenrolled, { kind: "owner-leaves", staffId: "a" }),
		).toBe(true);
		expect(
			leavesUsableOwner([{ staffId: "a", passkeyIds: [] }], {
				kind: "owner-leaves",
				staffId: "a",
			}),
		).toBe(true);
	});
});

describe("actors", () => {
	const device = { kind: "device", passkeyId: "p", name: "Old iPad" } as const;

	test("only owners and the trusted system administer", () => {
		const staff = (role: "owner" | "operator") =>
			({
				kind: "staff",
				staffId: "s",
				name: "Sam",
				role,
				via: device,
			}) as const;
		expect(mayAdminister(staff("owner"))).toBe(true);
		expect(mayAdminister(staff("operator"))).toBe(false);
		expect(mayAdminister({ kind: "legacy", via: device })).toBe(false);
		expect(mayAdminister(systemActor("recovery-script"))).toBe(true);
		for (const name of [
			"cron",
			"webhook",
			"upload-link",
			"stock-push",
		] as const)
			expect(mayAdminister(systemActor(name))).toBe(false);
	});

	test("an unassigned device is never described as a person", () => {
		expect(describeActor({ kind: "legacy", via: device })).toBe(
			"Unassigned device Old iPad",
		);
		expect(
			describeActor({
				kind: "legacy",
				via: { kind: "grant", grantId: "g", name: "Claude" },
			}),
		).toBe("Claude (unassigned)");
	});
});
