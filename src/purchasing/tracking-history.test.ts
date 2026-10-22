import { expect, test } from "vitest";
import { lacksHistory } from "./tracking-history";

const now = Date.parse("2026-10-22T12:00:00Z");
const row = (p: Partial<Parameters<typeof lacksHistory>[0]>) => ({
	history: [],
	service: null,
	checkedAt: null,
	...p,
});

test("a package without scans is asked about, at most once an hour", () => {
	expect(lacksHistory(row({}), now)).toBe(true);
	expect(lacksHistory(row({ checkedAt: "2026-10-22T10:00:00Z" }), now)).toBe(
		true,
	);
	expect(lacksHistory(row({ checkedAt: "2026-10-22T11:30:00Z" }), now)).toBe(
		false,
	);
});

test("a package with scans or a service already has its history", () => {
	expect(lacksHistory(row({ history: [{}] }), now)).toBe(false);
	expect(lacksHistory(row({ service: "Ground" }), now)).toBe(false);
});
