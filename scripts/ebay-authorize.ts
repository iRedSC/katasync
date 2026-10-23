// Signs katasync in to eBay again with every permission it uses, and saves
// the new refresh token in .env.local. Needed once to share seller standards
// on Markets (sell.analytics.readonly), which the first sign-in didn't ask
// for. The old token keeps working until it's replaced.
//
//   pnpm ebay:authorize
//
// Needs EBAY_RU_NAME: the app's RuName (eBay's name for its sign-in
// redirect), from the developer portal under User Tokens.
import { readFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { type } from "arktype";
import { API, EBAY_CONSENT_SCOPES } from "#/channels/ebay";

const ENV_FILE = ".env.local";
const KEY = "EBAY_REFRESH_TOKEN";

try {
	process.loadEnvFile(ENV_FILE);
} catch {
	// No .env.local; rely on the real environment.
}
const { EBAY_CLIENT_ID, EBAY_CLIENT_SECRET, EBAY_RU_NAME } = process.env;
if (!EBAY_CLIENT_ID || !EBAY_CLIENT_SECRET || !EBAY_RU_NAME)
	throw new Error(
		"Set EBAY_CLIENT_ID, EBAY_CLIENT_SECRET, and EBAY_RU_NAME (the app's RuName) first",
	);

const consent = new URL("https://auth.ebay.com/oauth2/authorize");
consent.search = new URLSearchParams({
	client_id: EBAY_CLIENT_ID,
	response_type: "code",
	redirect_uri: EBAY_RU_NAME,
	scope: EBAY_CONSENT_SCOPES.join(" "),
}).toString();
console.log(`Open this, sign in as the seller, and agree:\n\n${consent}\n`);

const prompt = createInterface({
	input: process.stdin,
	output: process.stdout,
});
const pasted = await prompt.question(
	"Paste the address eBay sent you to afterwards:\n> ",
);
prompt.close();
let code: string | null = null;
try {
	code = new URL(pasted.trim()).searchParams.get("code");
} catch {
	code = pasted.trim() || null;
}
if (!code) {
	console.error("No code in that. Paste the whole address from the browser.");
	process.exit(1);
}

const response = await fetch(`${API}/identity/v1/oauth2/token`, {
	method: "POST",
	headers: {
		Authorization: `Basic ${Buffer.from(`${EBAY_CLIENT_ID}:${EBAY_CLIENT_SECRET}`).toString("base64")}`,
		"Content-Type": "application/x-www-form-urlencoded",
	},
	body: new URLSearchParams({
		grant_type: "authorization_code",
		code,
		redirect_uri: EBAY_RU_NAME,
	}),
});
if (!response.ok) {
	console.error(
		`eBay didn't take the code: ${response.status} ${await response.text()}\nCodes work once and expire in minutes; run this again.`,
	);
	process.exit(1);
}
const { refresh_token: token } = type({ refresh_token: "string" }).assert(
	await response.json(),
);

// Replaces the line in place, quoted since eBay tokens hold "#".
let env = "";
try {
	env = readFileSync(ENV_FILE, "utf8");
} catch {
	// No file yet; it's created.
}
const line = `${KEY}="${token}"`;
const pattern = new RegExp(`^${KEY}=.*$`, "m");
env = pattern.test(env)
	? env.replace(pattern, line)
	: `${env}${env && !env.endsWith("\n") ? "\n" : ""}${line}\n`;
writeFileSync(ENV_FILE, env);

console.log(`\nSaved to ${ENV_FILE}.`);
console.log(
	`Set the same value as ${KEY} in Vercel (Settings > Environment Variables) and redeploy, and give it to profit-margarine too, which shares it:\n\n${token}\n`,
);
