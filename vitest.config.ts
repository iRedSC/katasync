import { defineConfig } from "vitest/config";

// Separate from vite.config.ts so tests don't load the Start and Nitro plugins.
export default defineConfig({
	resolve: { tsconfigPaths: true },
});
