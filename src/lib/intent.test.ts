import { expect, test } from "vitest";
import { answer } from "./answer";
import { answered, createIntent } from "./intent";

test("one intent cannot submit twice in the same tick", async () => {
	const intent = createIntent<{ id: string }>();
	let finish: ((value: string) => void) | undefined;
	let sends = 0;
	const first = intent.run(
		() => ({ id: "first" }),
		async () => {
			sends++;
			const value = await new Promise<string>((resolve) => {
				finish = resolve;
			});
			return { kind: "saved", value };
		},
	);
	expect(intent.getSnapshot().kind).toBe("pending");
	expect(
		await intent.run(
			() => ({ id: "second" }),
			async () => {
				sends++;
				return { kind: "saved", value: "duplicate" };
			},
		),
	).toEqual({ kind: "busy" });
	expect(sends).toBe(1);
	finish?.("saved");
	expect(await first).toEqual({ kind: "saved", value: "saved" });
	expect(intent.getSnapshot().kind).toBe("idle");
});

test("an uncertain retry keeps the original identity and payload despite edits", async () => {
	const intent = createIntent<{ id: string; applications: number[] }>();
	const original = { id: "payment-1", applications: [25] };
	await intent.run(
		() => original,
		async () => ({ kind: "uncertain" }),
	);
	original.applications.push(50);
	expect(intent.getSnapshot().kind).toBe("retry");
	await intent.run(
		() => ({ id: "payment-2", applications: [100] }),
		async (payload) => {
			expect(payload).toEqual({ id: "payment-1", applications: [25] });
			return { kind: "saved", value: "saved" };
		},
	);
});

test("a rejection saved nothing, so the next try sends what was fixed", async () => {
	const intent = createIntent<{ id: string; amountCents: number }>();
	const outcome = await intent.run(
		() => ({ id: "payment-1", amountCents: 5000 }),
		async () => ({ kind: "rejected", problem: "Only $20.00 open" }),
	);
	expect(outcome).toEqual({ kind: "rejected", problem: "Only $20.00 open" });
	expect(intent.getSnapshot().kind).toBe("idle");
	await intent.run(
		() => ({ id: "payment-2", amountCents: 2000 }),
		async (payload) => {
			expect(payload).toEqual({ id: "payment-2", amountCents: 2000 });
			return { kind: "saved", value: null };
		},
	);
});

test("a thrown transport error retains the intent for retry", async () => {
	const intent = createIntent<string>();
	await expect(
		intent.run(
			() => "original",
			async () => {
				throw new Error("connection lost");
			},
		),
	).rejects.toThrow("connection lost");
	expect(
		await intent.run(
			() => "edited",
			async (payload) => ({ kind: "saved", value: payload }),
		),
	).toEqual({ kind: "saved", value: "original" });
});

class RuleError extends Error {}

test("a server's refusal is a rejection, and a send that threw is uncertain", async () => {
	const refusal = await answer([RuleError], async () => {
		throw new RuleError("Invoice INV-1 is void");
	});
	expect(answered({ value: refusal })).toEqual({
		kind: "rejected",
		problem: "Invoice INV-1 is void",
	});
	expect(answered({ value: await answer([RuleError], async () => 7) })).toEqual(
		{ kind: "saved", value: 7 },
	);
	expect(answered(null)).toEqual({ kind: "uncertain" });
	await expect(
		answer([RuleError], async () => {
			throw new Error("deadlock detected");
		}),
	).rejects.toThrow("deadlock detected");
});

test("a retry is let go only once the server says how it ended", async () => {
	const intent = createIntent<string>();
	const hold = () =>
		intent.run(
			() => "original",
			async () => ({ kind: "uncertain" }),
		);
	await hold();
	// The answer was lost and the server can't be asked: still held.
	expect(await intent.release(async () => null)).toBeNull();
	expect(intent.getSnapshot()).toEqual({ kind: "retry", payload: "original" });
	await expect(
		intent.release(async () => {
			throw new Error("offline");
		}),
	).rejects.toThrow("offline");
	expect(intent.getSnapshot().kind).toBe("retry");
	// Recorded, or confirmed missing: the next run captures afresh.
	expect(await intent.release(async () => true)).toBe(true);
	expect(intent.getSnapshot().kind).toBe("idle");
	await hold();
	expect(await intent.release(async () => false)).toBe(false);
	expect(
		await intent.run(
			() => "edited",
			async (p) => ({ kind: "saved", value: p }),
		),
	).toEqual({ kind: "saved", value: "edited" });
});

test("nothing sends while a retry is being checked", async () => {
	const intent = createIntent<string>();
	await intent.run(
		() => "original",
		async () => ({ kind: "uncertain" }),
	);
	let answer: ((recorded: boolean) => void) | undefined;
	const checking = intent.release(
		() =>
			new Promise<boolean>((resolve) => {
				answer = resolve;
			}),
	);
	expect(intent.getSnapshot().kind).toBe("checking");
	expect(
		await intent.run(
			() => "edited",
			async (p) => ({ kind: "saved", value: p }),
		),
	).toEqual({ kind: "busy" });
	answer?.(false);
	await checking;
	expect(intent.getSnapshot().kind).toBe("idle");
});

test("a send in flight can't be released", async () => {
	const intent = createIntent<string>();
	let finish: ((value: string) => void) | undefined;
	const first = intent.run(
		() => "edited",
		async () => ({
			kind: "saved",
			value: await new Promise<string>((resolve) => {
				finish = resolve;
			}),
		}),
	);
	expect(await intent.release(async () => false)).toBeNull();
	expect(intent.getSnapshot().kind).toBe("pending");
	finish?.("saved");
	await first;
});
