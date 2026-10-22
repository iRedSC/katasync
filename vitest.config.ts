import { globSync, readFileSync } from "node:fs";
import { availableParallelism } from "node:os";
import { configDefaults, defineConfig } from "vitest/config";

// Test files that replace a module with vi.mock. A mock only takes when the
// module loads, and a worker shared between files may have loaded it already,
// so these each get a fresh process. Found here rather than listed, so a new
// one can't quietly get the real module.
const TESTS = "{src,scripts}/**/*.test.{ts,tsx}";
const mocking = globSync(TESTS).filter((file) =>
	readFileSync(file, "utf8").includes("vi.mock("),
);

// Every worker boots its own PGlite database (src/test/db.ts) and holds it in
// memory, and several agents often test at once. So DB tests get half the
// host's cores: at least one, at most four. A 4-core host gets two.
const DB_WORKERS = Math.min(
	4,
	Math.max(1, Math.floor(availableParallelism() / 2)),
);

// Separate from vite.config.ts so tests don't load the Start and Nitro plugins.
export default defineConfig({
	resolve: { tsconfigPaths: true },
	test: {
		// What a file stubs or spies on is undone after each test, so nothing
		// carries into the next file sharing its worker.
		unstubEnvs: true,
		unstubGlobals: true,
		restoreMocks: true,
		maxWorkers: DB_WORKERS,
		projects: [
			{
				extends: true,
				test: {
					name: "shared",
					include: [TESTS],
					exclude: [...configDefaults.exclude, ...mocking],
					// Test files reuse worker processes, so each worker boots and
					// migrates its test database once (src/test/db.ts) instead of
					// once per file.
					isolate: false,
				},
			},
			{
				extends: true,
				test: { name: "mocking", include: mocking, isolate: true },
			},
		],
	},
});
