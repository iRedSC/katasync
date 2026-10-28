import { expect, test } from "vitest";
import { hide, noneHidden, retire, unhide, visible } from "./hidden-threads";

const threads = [{ id: 1 }, { id: 2 }];

test("a conversation marked done leaves Open but still shows in Done", () => {
	const hidden = hide(noneHidden, 1, "open");
	expect(visible(threads, hidden, "open")).toEqual([{ id: 2 }]);
	expect(visible(threads, hidden, "done")).toEqual(threads);
});

test("it is let go once the list it left no longer has it", () => {
	const hidden = hide(noneHidden, 1, "open");
	// The server's Open list still has it: keep hiding.
	expect(retire(hidden, "open", threads)).toBe(hidden);
	// The Done list having it says nothing about Open.
	expect(retire(hidden, "done", [{ id: 1 }])).toBe(hidden);
	// The server's Open list moved on.
	expect(retire(hidden, "open", [{ id: 2 }]).has(1)).toBe(false);
});

test("putting one back shows it again", () => {
	const hidden = hide(noneHidden, 2, "done");
	expect(visible(threads, unhide(hidden, 2), "done")).toEqual(threads);
	expect(unhide(hidden, 9)).toBe(hidden);
});
