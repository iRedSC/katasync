import { afterEach, beforeEach, expect, test, vi } from "vitest";

const replyToBuyer = vi.fn(async () => ({ id: 1, status: "sent" as const }));
vi.mock("#/server/buyers", () => ({ replyToBuyer }));

const out = await import("./outgoing");

beforeEach(() => {
	vi.useFakeTimers();
	replyToBuyer.mockClear();
});
afterEach(() => vi.useRealTimers());

test("held for the hold, then sent once under its key", async () => {
	expect(out.hold({ key: "k1", threadId: 1, body: "Hi" })).toBe(true);
	// The same key again is the same reply.
	expect(out.hold({ key: "k1", threadId: 1, body: "Hi" })).toBe(false);
	await vi.advanceTimersByTimeAsync(out.HOLD_MS - 1);
	expect(replyToBuyer).not.toHaveBeenCalled();
	await vi.advanceTimersByTimeAsync(1);
	expect(replyToBuyer).toHaveBeenCalledTimes(1);
	expect(replyToBuyer).toHaveBeenCalledWith({
		data: { threadId: 1, text: "Hi", requestKey: "k1" },
	});
	// Gone: undo can't take it back.
	expect(out.undo("k1")).toBe(false);
});

test("undo inside the hold sends nothing and gives the words back", async () => {
	out.hold({ key: "k2", threadId: 2, body: "Oops" });
	expect(out.undo("k2")).toBe(true);
	await vi.advanceTimersByTimeAsync(out.HOLD_MS * 2);
	expect(replyToBuyer).not.toHaveBeenCalled();
	expect(out.takeReturned(2)).toBe("Oops");
	expect(out.takeReturned(2)).toBeUndefined();
});

test("send now doesn't wait, and the timer doesn't send it again", async () => {
	out.hold({ key: "k3", threadId: 3, body: "Now" });
	out.sendNow("k3");
	await vi.advanceTimersByTimeAsync(out.HOLD_MS * 2);
	expect(replyToBuyer).toHaveBeenCalledTimes(1);
});
