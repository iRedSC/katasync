import { describe, expect, it } from "vitest";
import { journalProblems, skippedMigrations } from "./check-migrations";

describe("journalProblems", () => {
	it("passes entries in place and in time order", () => {
		expect(
			journalProblems([
				{ idx: 0, tag: "0000_a", when: 1 },
				{ idx: 1, tag: "0001_b", when: 2 },
			]),
		).toEqual([]);
	});

	it("catches one dated before the entry ahead of it", () => {
		expect(
			journalProblems([
				{ idx: 0, tag: "0000_a", when: 5 },
				{ idx: 1, tag: "0001_b", when: 3 },
			]),
		).toEqual([
			"0001_b is dated before 0000_a, so a database that has 0000_a skips it",
		]);
	});

	it("catches a renumbering that left idx behind", () => {
		expect(journalProblems([{ idx: 1, tag: "0000_a", when: 1 }])).toEqual([
			"0000_a is at position 0 but says idx 1",
		]);
	});
});

describe("skippedMigrations", () => {
	const a = { tag: "0000_a", when: 10, hash: "a" };
	const b = { tag: "0001_b", when: 20, hash: "b" };

	it("lets a fresh database take everything", () => {
		expect(skippedMigrations([a, b], [])).toEqual([]);
	});

	it("lets a newer migration through", () => {
		expect(skippedMigrations([a, b], [{ hash: "a", createdAt: 10 }])).toEqual([]);
	});

	it("catches one older than a migration another branch applied", () => {
		// Another branch's migration, dated 30, reached the database first.
		expect(
			skippedMigrations([a, b], [
				{ hash: "a", createdAt: 10 },
				{ hash: "other", createdAt: 30 },
			]),
		).toEqual([b]);
	});

	it("catches an applied migration edited since", () => {
		const edited = { ...a, hash: "a2" };
		expect(skippedMigrations([edited], [{ hash: "a", createdAt: 10 }])).toEqual([
			edited,
		]);
	});
});
