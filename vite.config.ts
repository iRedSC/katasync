import tailwindcss from "@tailwindcss/vite";

import { tanstackStart } from "@tanstack/react-start/plugin/vite";

import viteReact from "@vitejs/plugin-react";
import { nitro } from "nitro/vite";
import { defineConfig } from "vite";

// `neon link` writes connection strings to .env.local. Server code reads
// process.env, which Vite doesn't fill on its own.
try {
	process.loadEnvFile(".env.local");
} catch {
	// No .env.local (e.g. on Vercel); the real environment applies.
}

const config = defineConfig({
	resolve: { tsconfigPaths: true },
	// Dev is reached over `tailscale serve` (https://<machine>.<tailnet>.ts.net:3000).
	// Bound to 127.0.0.1 so it doesn't clash with tailscale serve's listener on
	// the same port.
	server: { host: "127.0.0.1", allowedHosts: [".ts.net"] },
	plugins: [
		nitro({
			// Left as packages rather than bundled. SimpleWebAuthn's certificate
			// library needs reflect-metadata loaded first, and bundling reorders
			// that. react-pdf loads its fonts through package imports
			// (#standard-fonts/...) that only resolve inside its own package.
			traceDeps: [
				"@simplewebauthn/server*",
				"@react-pdf/renderer*",
				"@react-pdf/font*",
				"pdfkit*",
			],
		}),
		tailwindcss(),
		tanstackStart(),
		viteReact(),
	],
});

export default config;
