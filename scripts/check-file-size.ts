// Pre-commit check: no staged file may be over 5,000 tokens (bytes / 4).
//
//   node scripts/check-file-size.ts        check what's staged (the hook runs this)
//
// Files that agents don't write (lockfiles, codegen, vendored skills, binaries)
// are skipped. A file that was already over the limit at HEAD may be committed
// as long as it doesn't grow, so a fix in one doesn't force a split first; any
// file that crosses the limit, or grows while over it, blocks the commit.
//
// Runs on Node's own type stripping, so it imports nothing but node: modules.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const MAX_TOKENS = 5000;
const BYTES_PER_TOKEN = 4;

export const tokensOf = (bytes: number) => Math.ceil(bytes / BYTES_PER_TOKEN);

// Paths agents don't author. Add generated or vendored paths here rather than
// splitting them.
const IGNORED: RegExp[] = [
	/(^|\/)(pnpm-lock\.yaml|package-lock\.json|yarn\.lock|bun\.lockb?|skills-lock\.json)$/,
	/^drizzle\/meta\//, // drizzle-kit snapshots and journal
	/\.gen\.[cm]?[jt]sx?$/, // routeTree.gen.ts and the like
	/^src\/components\/ui\//, // shadcn components, added by its CLI
];

export type StagedFile = {
	path: string;
	// Size at HEAD, under its old name if it was renamed; null for a new file.
	headBytes: number | null;
	stagedBytes: number;
	binary: boolean;
};

export type Problem =
	| { kind: "over"; path: string; tokens: number }
	| { kind: "grew"; path: string; tokens: number; headTokens: number };

export function isIgnored(path: string, vendored: readonly string[]): boolean {
	return (
		IGNORED.some((pattern) => pattern.test(path)) ||
		vendored.some((dir) => path.startsWith(`${dir}/`))
	);
}

export function findProblems(
	files: readonly StagedFile[],
	vendored: readonly string[] = [],
): Problem[] {
	const problems: Problem[] = [];
	for (const file of files) {
		if (file.binary || isIgnored(file.path, vendored)) continue;
		const tokens = tokensOf(file.stagedBytes);
		if (tokens <= MAX_TOKENS) continue;
		const headTokens = file.headBytes === null ? null : tokensOf(file.headBytes);
		if (headTokens === null || headTokens <= MAX_TOKENS) {
			problems.push({ kind: "over", path: file.path, tokens });
		} else if (tokens > headTokens) {
			problems.push({ kind: "grew", path: file.path, tokens, headTokens });
		}
	}
	return problems;
}

const fmt = (n: number) => n.toLocaleString("en-US");

export function report(problems: readonly Problem[]): string {
	const width = Math.max(...problems.map((p) => p.path.length));
	const lines = problems.map((p) => {
		const where = p.path.padEnd(width);
		return p.kind === "over"
			? `  ${where}  ${fmt(p.tokens)} tokens`
			: `  ${where}  ${fmt(p.tokens)} tokens, up from ${fmt(p.headTokens)}. It was already over the limit; it may shrink or stay the same, not grow.`;
	});
	const count =
		problems.length === 1 ? "1 staged file is" : `${problems.length} staged files are`;
	return `
Commit blocked: ${count} over ${fmt(MAX_TOKENS)} tokens (bytes / ${BYTES_PER_TOKEN}, so ${fmt(MAX_TOKENS * BYTES_PER_TOKEN)} bytes).

${lines.join("\n")}

Split each file before committing:

  1. Read the whole file and list its responsibilities: groups of functions,
     types, or components that change together. Each group becomes a file.
  2. Make the new files siblings in a folder named for the original
     (src/purchasing/orders.ts -> src/purchasing/orders/receive.ts,
     src/purchasing/orders/invoices.ts, ...). Name each for what it does,
     never utils.ts, helpers.ts, or misc.ts.
  3. Keep the original import path working: leave the main entry point in
     the original file, or make it an index.ts that re-exports, so callers
     elsewhere don't change. Then update imports only where they break.
  4. Types shared by several new files go in their own types.ts next to them.
  5. React routes and pages: move each sub-component, dialog, and table into
     its own file beside the route; keep the route file to the route
     definition, its loader, and the top-level page component.
  6. Tests (*.test.ts): split by the behavior under test, mirroring the source
     split, and move shared fixtures and builders into a *.fixtures.ts file.
  7. Move code verbatim. Don't shorten names, strip comments, or compress
     formatting to get under the limit; that hides the problem.
  8. Run the tests for what you moved, re-stage (git add -A on the new
     files and the original), and commit again.

If a file here is generated or vendored rather than written, add its path to
IGNORED in scripts/check-file-size.ts instead of splitting it.
`;
}

function git(args: string[]): string {
	return execFileSync("git", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
}

function blobSize(spec: string): number | null {
	try {
		return Number(git(["cat-file", "-s", spec]).trim());
	} catch {
		return null;
	}
}

// Git's own test: a NUL byte in the first 8,000 bytes means binary.
function isBinary(spec: string): boolean {
	const head = execFileSync("git", ["cat-file", "blob", spec], {
		maxBuffer: 64 * 1024 * 1024,
	}).subarray(0, 8000);
	return head.includes(0);
}

function stagedFiles(): StagedFile[] {
	const fields = git([
		"diff",
		"--cached",
		"--name-status",
		"--find-renames",
		"--diff-filter=ACMR",
		"-z",
	]).split("\0");
	const files: StagedFile[] = [];
	for (let i = 0; i < fields.length - 1; ) {
		const status = fields[i++];
		const from = fields[i++];
		const path = status.startsWith("R") || status.startsWith("C") ? fields[i++] : from;
		const stagedBytes = blobSize(`:${path}`) ?? 0;
		files.push({
			path,
			headBytes: status.startsWith("A") || status.startsWith("C") ? null : blobSize(`HEAD:${from}`),
			stagedBytes,
			// Only worth reading the blob when it's big enough to matter.
			binary: tokensOf(stagedBytes) > MAX_TOKENS && isBinary(`:${path}`),
		});
	}
	return files;
}

// Skills installed by `npx skills` are vendored; skills-lock.json lists them.
function vendoredSkills(): string[] {
	try {
		const lock = JSON.parse(readFileSync("skills-lock.json", "utf8"));
		return Object.keys(lock.skills ?? {}).map((name) => `.claude/skills/${name}`);
	} catch {
		return [];
	}
}

// Run directly (not imported by the tests).
if (process.argv[1] === fileURLToPath(import.meta.url)) {
	const problems = findProblems(stagedFiles(), vendoredSkills());
	if (problems.length > 0) {
		process.stderr.write(report(problems));
		process.exit(1);
	}
}
