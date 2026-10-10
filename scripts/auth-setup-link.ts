// Prints a one-time link for adding a device: the first one, or any time
// every device has lost its passkey. Running it needs the database, which is
// what makes it safe.
//
//   pnpm auth:setup-link
import { createSetupLink } from "#/auth/sessions";
import { getDb } from "#/db/client";

try {
	process.loadEnvFile(".env.local");
} catch {
	// No .env.local; rely on the real environment.
}

const origin = process.env.AUTH_ORIGIN;
if (!origin) throw new Error("Set AUTH_ORIGIN, e.g. https://katasync.example.com");
const minutes = 30;
const token = await createSetupLink(getDb(), minutes);
console.log(`Open this on the device within ${minutes} minutes:\n\n${origin}/setup?token=${token}\n`);
process.exit(0);
