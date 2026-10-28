import { toast } from "sonner";
import { describe, expect, it, vi } from "vitest";
import { undone } from "./undone";

vi.mock("sonner", () => ({ toast: { error: vi.fn() } }));

const words = { done: "$5.00 is on INV-1 again", refusal: "$5.00 isn't back" };

describe("undone", () => {
	it("says an undo the server refused didn't happen, and why", () => {
		expect(
			undone({ kind: "rejected", problem: "Only $2.00 open" }, words),
		).toBeNull();
		expect(toast.error).toHaveBeenCalledWith(
			"$5.00 isn't back: Only $2.00 open",
		);
	});

	it("says what was undone only once it saved", () => {
		expect(undone({ kind: "saved", value: 1 }, words)).toBe(words.done);
		expect(undone({ kind: "uncertain" }, words)).toBeNull();
	});
});
