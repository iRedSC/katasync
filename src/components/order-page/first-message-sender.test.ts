import { expect, test, vi } from "vitest";
import type { FirstMessage } from "#/buyers/chat-way";
import { firstMessageSender } from "./first-message-sender";

let n = 0;
const newKey = () => `key-${++n}`;

test("a second press while a try is out sends nothing", async () => {
	let finish: (r: FirstMessage) => void = () => {};
	const send = vi.fn(
		() => new Promise<FirstMessage>((resolve) => (finish = resolve)),
	);
	const s = firstMessageSender(send, newKey);
	const first = s.send("Hi");
	expect(await s.send("Hi")).toBeNull();
	expect(await s.send("Hi")).toBeNull();
	finish({ kind: "sent", threadId: 1 });
	expect(await first).toEqual({ kind: "sent", threadId: 1 });
	expect(send).toHaveBeenCalledTimes(1);
});

test("asking again after a lost answer uses the same key", async () => {
	const send = vi
		.fn<(text: string, key: string) => Promise<FirstMessage>>()
		.mockRejectedValueOnce(new Error("Failed to fetch"))
		.mockResolvedValueOnce({ kind: "sent_unlisted" });
	const s = firstMessageSender(send, newKey);
	expect((await s.send("Hi"))?.kind).toBe("lost");
	expect(s.open).toBe(true);
	await s.send("Hi");
	expect(send.mock.calls[0]?.[1]).toBe(send.mock.calls[1]?.[1]);
	expect(s.open).toBe(false);
});

test("still sending keeps the key; a settled try makes the next one new", async () => {
	const send = vi
		.fn<(text: string, key: string) => Promise<FirstMessage>>()
		.mockResolvedValueOnce({ kind: "sending" })
		.mockResolvedValueOnce({ kind: "unsure", reason: "eBay 503" })
		.mockResolvedValueOnce({ kind: "sent", threadId: 2 });
	const s = firstMessageSender(send, newKey);
	await s.send("Hi");
	await s.send("Hi");
	// Send anyway, after unsure: a new try.
	await s.send("Hi");
	const keys = send.mock.calls.map((c) => c[1]);
	expect(keys[0]).toBe(keys[1]);
	expect(keys[2]).not.toBe(keys[1]);
});
