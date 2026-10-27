import { afterEach, describe, expect, test, vi } from "vitest";
import { endpoints, originOf } from "./oauth";
import { appOrigin } from "./origin";
import { AuthError } from "./sessions";
import { relyingParty } from "./webauthn";

// OAuth and passkeys read AUTH_ORIGIN the same way: only its origin.

afterEach(() => vi.unstubAllEnvs());
const request = new Request("https://preview.example.net/mcp");

describe("AUTH_ORIGIN", () => {
	test.each([
		"https://katasync.test",
		"https://katasync.test/",
		"  https://katasync.test/  ",
		"https://katasync.test/some/path?x=1",
	])("%j is the origin, for every use", (setting) => {
		vi.stubEnv("AUTH_ORIGIN", setting);
		expect(appOrigin()).toBe("https://katasync.test");
		expect(originOf(request)).toBe("https://katasync.test");
		expect(relyingParty()).toMatchObject({
			origin: "https://katasync.test",
			id: "katasync.test",
		});
		expect(endpoints(originOf(request)).resource).toBe(
			"https://katasync.test/mcp",
		);
	});

	test("unset, OAuth uses the request's address and passkeys refuse", () => {
		vi.stubEnv("AUTH_ORIGIN", "   ");
		expect(originOf(request)).toBe("https://preview.example.net");
		expect(() => relyingParty()).toThrow(AuthError);
	});

	test.each([
		"katasync.test",
		"javascript:alert(1)",
		"ftp://katasync.test",
	])("%j is refused everywhere, not worked around", (setting) => {
		vi.stubEnv("AUTH_ORIGIN", setting);
		expect(() => appOrigin()).toThrow(/AUTH_ORIGIN/);
		expect(() => originOf(request)).toThrow(/AUTH_ORIGIN/);
	});
});
