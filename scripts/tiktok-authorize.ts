// Turns the link TikTok sends you to after the shop authorizes the app into
// a new refresh token, and saves it in .env.local. Run it, authorize the app
// in TikTok, then paste the address you landed on (or just its code). The
// code works once and only for a few minutes.
//
//   pnpm tiktok:authorize
//
// A token missing any of TIKTOK_SCOPES isn't saved: the fix then is in
// Partner Center (the permission isn't approved or published yet), and the
// token already in .env.local keeps working meanwhile.
import { readFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { type } from "arktype";
import { TIKTOK_SCOPES } from "#/channels/tiktok";

const ENV_FILE = ".env.local";
const KEY = "TIKTOK_REFRESH_TOKEN";

try {
	process.loadEnvFile(ENV_FILE);
} catch {
	// No .env.local; rely on the real environment.
}
const { TIKTOK_CLIENT_KEY, TIKTOK_CLIENT_SECRET } = process.env;
if (!TIKTOK_CLIENT_KEY || !TIKTOK_CLIENT_SECRET)
	throw new Error("Set TIKTOK_CLIENT_KEY and TIKTOK_CLIENT_SECRET first");

// The code from the address TikTok redirected to, or the code itself.
export function authCode(pasted: string): string | null {
	const text = pasted.trim();
	if (!text) return null;
	try {
		return new URL(text).searchParams.get("code");
	} catch {
		return /^[\w-]+$/.test(text) ? text : null;
	}
}

const reply = type({
	code: "number",
	message: "string",
	"data?": {
		"refresh_token?": "string",
		"granted_scopes?": "string[]",
		"seller_name?": "string",
	},
});

const prompt = createInterface({
	input: process.stdin,
	output: process.stdout,
});
const pasted = await prompt.question(
	"Paste the address TikTok sent you to after authorizing (or its code):\n> ",
);
prompt.close();
const code = authCode(pasted);
if (!code) {
	console.error("No code in that. Paste the whole address from the browser.");
	process.exit(1);
}

const params = new URLSearchParams({
	app_key: TIKTOK_CLIENT_KEY,
	app_secret: TIKTOK_CLIENT_SECRET,
	auth_code: code,
	grant_type: "authorized_code",
});
const response = await fetch(
	`https://auth.tiktok-shops.com/api/v2/token/get?${params}`,
);
const body = reply.assert(await response.json());
const token = body.data?.refresh_token;
if (body.code !== 0 || !token) {
	console.error(
		`TikTok didn't take the code: ${body.message}. Codes work once and expire in minutes; authorize again and paste the new address.`,
	);
	process.exit(1);
}

const granted = body.data?.granted_scopes ?? [];
const missing = TIKTOK_SCOPES.filter((s) => !granted.includes(s));
console.log(`Shop: ${body.data?.seller_name ?? "unknown"}`);
console.log(`Granted: ${granted.join(", ")}`);
if (missing.length > 0) {
	console.error(
		`\nNot saved: the token is missing ${missing.join(", ")}.\nIn Partner Center, check those are approved for the app (and its new version published), then authorize the shop again. The token in ${ENV_FILE} is unchanged.`,
	);
	process.exit(1);
}

// Replaces the line in place, or adds it, leaving the rest of the file be.
let env = "";
try {
	env = readFileSync(ENV_FILE, "utf8");
} catch {
	// No file yet; it's created.
}
const line = `${KEY}=${token}`;
const pattern = new RegExp(`^${KEY}=.*$`, "m");
env = pattern.test(env)
	? env.replace(pattern, line)
	: `${env}${env && !env.endsWith("\n") ? "\n" : ""}${line}\n`;
writeFileSync(ENV_FILE, env);

console.log(`\nSaved to ${ENV_FILE}, with every permission katasync needs.`);
console.log(
	`Set the same value as ${KEY} in Vercel (Settings > Environment Variables) and redeploy, so production uses it too:\n\n${token}\n`,
);
