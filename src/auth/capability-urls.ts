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

// Any upload link, even of a kind added since, and the rest by path; a staff
// setup link too, should one be pasted. The token is base64url.
const CAPABILITY = new RegExp(
	`(/api/uploads/[a-z0-9-]+/|${CAPABILITY_PATHS.map((p) => p.replace(/[/-]/g, "\\$&")).join("|")}|/setup\\?token=)[A-Za-z0-9_-]+`,
	"g",
);

export const redactCapabilities = (text: string, marker: string) =>
	text.replace(CAPABILITY, `$1${marker}`);
