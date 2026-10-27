import { appOrigin } from "./origin";

// Addresses that are their own credential: whoever has one can use it, with
// no session (src/auth/guard.ts lets them through). Every one katasync hands
// out is built here, and the same list is what's kept out of logs anyone
// approved read only can read (src/mcp/log.ts). Server only.
const CAPABILITY_PATHS = [
	"/api/uploads/po-file/",
	"/api/uploads/damage/",
	"/api/shared-files/",
] as const;

export type CapabilityPath = (typeof CAPABILITY_PATHS)[number];

export const capabilityUrl = (path: CapabilityPath, token: string) =>
	`${appOrigin()}${path}${token}`;

// Any upload link, even of a kind added since, and the rest by path; a token
// in any query (a staff setup link pasted, wherever its token sits) too. A
// slash or = may come percent-encoded, as in a link inside another link, and
// still opens. The token is base64url. drizzle/0153 scrubs with the same
// pattern, kept equal by src/mcp/log.test.ts.
const SLASH = "(?:/|%2[Ff])";
const path = (p: string) => p.split("/").join(SLASH);
export const CAPABILITY_PATTERN = `(${[
	`${SLASH}api${SLASH}uploads${SLASH}[a-z0-9-]+${SLASH}`,
	...CAPABILITY_PATHS.map(path),
	"token(?:=|%3[Dd])",
].join("|")})[A-Za-z0-9_-]+`;
const CAPABILITY = new RegExp(CAPABILITY_PATTERN, "g");

export const redactCapabilities = (text: string, marker: string) =>
	text.replace(CAPABILITY, `$1${marker}`);
