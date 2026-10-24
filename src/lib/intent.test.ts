import { expect, test } from "vitest";
import { createIntent } from "./intent";

test("one intent cannot submit twice in the same tick", async () => {
	const intent = createIntent<{ id: string }>();
	let finish: ((value: string) => void) | undefined;
	let sends = 0;
	const first = intent.run(
		() => ({ id: "first" }),
		async () => {
			sends++;
			return new Promise<string>((resolve) => {
				finish = resolve;
			});
		},
	);
	expect(intent.getSnapshot().kind).toBe("pending");
	expect(
		await intent.run(
			() => ({ id: "second" }),
			async () => {
				sends++;
				return "duplicate";
			},
		),
	).toBeNull();
	expect(sends).toBe(1);
	finish?.("saved");
	expect(await first).toBe("saved");
	expect(intent.getSnapshot().kind).toBe("idle");
});

test("an uncertain retry keeps the original identity and payload despite edits", async () => {
	const intent = createIntent<{ id: string; applications: number[] }>();
	const original = { id: "payment-1", applications: [25] };
	await intent.run(
		() => original,
		async () => null,
	);
	original.applications.push(50);
	expect(intent.getSnapshot().kind).toBe("retry");
	await intent.run(
		() => ({ id: "payment-2", applications: [100] }),
		async (payload) => {
			expect(payload).toEqual({ id: "payment-1", applications: [25] });
			return "saved";
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
			async (payload) => payload,
		),
	).toBe("original");
});
