import { describe, expect, it } from "vitest";
import { findProblems, MAX_TOKENS, type StagedFile } from "./check-file-size";

const LIMIT = MAX_TOKENS * 4;
const file = (path: string, stagedBytes: number, headBytes: number | null = null): StagedFile => ({
	path,
	stagedBytes,
	headBytes,
	binary: false,
});

describe("findProblems", () => {
	it("allows a file exactly at the limit and blocks one byte past it", () => {
		expect(findProblems([file("src/a.ts", LIMIT)])).toEqual([]);
		expect(findProblems([file("src/a.ts", LIMIT + 1)])).toEqual([
			{ kind: "over", path: "src/a.ts", tokens: MAX_TOKENS + 1 },
		]);
	});

	it("blocks a file that crosses the limit", () => {
		expect(findProblems([file("src/a.ts", LIMIT + 400, LIMIT - 400)])).toHaveLength(1);
	});

	it("lets a file already over the limit shrink or stay, not grow", () => {
		expect(findProblems([file("src/a.ts", LIMIT * 2, LIMIT * 2)])).toEqual([]);
		expect(findProblems([file("src/a.ts", LIMIT * 2 - 100, LIMIT * 2)])).toEqual([]);
		expect(findProblems([file("src/a.ts", LIMIT * 2 + 100, LIMIT * 2)])).toEqual([
			{ kind: "grew", path: "src/a.ts", tokens: MAX_TOKENS * 2 + 25, headTokens: MAX_TOKENS * 2 },
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
					file(".claude/skills/neon/SKILL.md", big),
					{ ...file("public/receive-512.png", big), binary: true },
				],
				[".claude/skills/neon"],
			),
		).toEqual([]);
	});

	it("still checks skills that aren't vendored", () => {
		expect(
			findProblems([file(".claude/skills/neon-extra/SKILL.md", LIMIT * 2)], [".claude/skills/neon"]),
		).toHaveLength(1);
	});
});
