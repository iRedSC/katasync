import { describe, expect, it } from "vitest";
import { createDrafts } from "./match-drafts";

describe("match drafts", () => {
	it("keeps a failed new product for a picker mounted after it failed", () => {
		const drafts = createDrafts();
		// The queue's last item: its picker unmounted as it was created, and
		// the failure lands with no picker showing.
		drafts.set("1,2", { sku: "ABC-1", name: "Taping knife" });
		expect(drafts.get("1,2")).toEqual({ sku: "ABC-1", name: "Taping knife" });
		expect(drafts.get("3")).toBeNull();
	});

	it("tells pickers when a draft comes or goes, and only then", () => {
		const drafts = createDrafts();
		let calls = 0;
		drafts.subscribe(() => calls++);
		drafts.set("1", { sku: "A", name: "A" });
		drafts.set("1", null);
		drafts.set("1", null);
		expect(calls).toBe(2);
		expect(drafts.get("1")).toBeNull();
	});
});
