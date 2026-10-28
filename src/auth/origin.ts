import { AuthError } from "./sessions";

// The address katasync is opened at, from AUTH_ORIGIN, as one origin for
// everything built on it: passkeys, OAuth's endpoints, and links handed out.
// The browser reports a bare origin, so a trailing slash, a path, or spaces
// in the setting are dropped rather than failing a check or making
// https://host//mcp. Server only.

const EXAMPLE = "e.g. https://katasync.example.com";

// The origin AUTH_ORIGIN names; null when it isn't set. A setting that isn't
// an http(s) address throws, rather than quietly using another.
function configured(): URL | null {
	const setting = process.env.AUTH_ORIGIN?.trim();
	if (!setting) return null;
	let url: URL;
	try {
		url = new URL(setting);
	} catch {
		throw new AuthError(
			`AUTH_ORIGIN needs to be a full address with https://, ${EXAMPLE}`,
		);
	}
	if (url.protocol !== "https:" && url.protocol !== "http:")
		throw new AuthError(
			`AUTH_ORIGIN needs to be a full address with https://, ${EXAMPLE}`,
		);
	return new URL(url.origin);
}

// The origin, and its host name for passkeys. Throws when it isn't set.
export function appUrl() {
	const url = configured();
	if (!url)
		throw new AuthError(
			`Set AUTH_ORIGIN to the address katasync is opened at, ${EXAMPLE}`,
		);
	return { origin: url.origin, hostname: url.hostname };
}

export const appOrigin = () => appUrl().origin;

// AUTH_ORIGIN's origin, or the request's own when it isn't set (a dev
// server opened at whatever address).
export const originOf = (request: Request) =>
	configured()?.origin ?? new URL(request.url).origin;
