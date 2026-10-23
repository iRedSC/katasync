import { describe, expect, it } from "vitest";
import { findProblems, MAX_TOKENS, type StagedFile } from "./check-file-size";

const LIMIT = MAX_TOKENS * 4;
const file = (path: string, bytes: number): StagedFile => ({
	path,
	bytes,
	binary: false,
});

describe("findProblems", () => {
	it("allows a file exactly at the limit and blocks one byte past it", () => {
		expect(findProblems([file("src/a.ts", LIMIT)])).toEqual([]);
		expect(findProblems([file("src/a.ts", LIMIT + 1)])).toEqual([
			{ path: "src/a.ts", tokens: MAX_TOKENS + 1 },
		]);
	});

	it("skips lockfiles, codegen, shadcn, vendored skills, and binaries", () => {
		const big = LIMIT * 10;
		expect(
			findProblems(
				[
					file("pnpm-lock.yaml", big),
					file("drizzle/meta/0052_snapshot.json", big),
					file("src/routeTree.gen.ts", big),
					file("src/components/ui/sidebar.tsx", big),
					file("src/db/schema.ts", big),
					file(".claude/skills/neon/SKILL.md", big),
					{ ...file("public/receive-512.png", big), binary: true },
				],
				[".claude/skills/neon"],
			),
		).toEqual([]);
	});

	it("still checks skills that aren't vendored", () => {
		expect(
			findProblems(
				[file(".claude/skills/neon-extra/SKILL.md", LIMIT * 2)],
				[".claude/skills/neon"],
			),
		).toHaveLength(1);
	});
});
