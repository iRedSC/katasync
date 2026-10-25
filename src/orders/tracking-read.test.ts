import { expect, test } from "vitest";
import { afterFailure, knownOf, type Tracked } from "./tracking-read";

const known: Tracked = {
	carrier: "ups",
	number: "1Z999AA10123456784",
	status: "TRANSIT",
	statusDetail: null,
	statusAt: null,
	eta: null,
	originalEta: null,
	service: null,
	origin: null,
	destination: null,
	history: [{ status: "TRANSIT", detail: "Picked up", at: null, place: null }],
	checkedAt: new Date("2026-10-24T10:00:00Z"),
};
const at = new Date("2026-10-25T10:00:00Z");

test("a failure after an answer keeps its scans, stale", () => {
	const r = afterFailure(known, new Error("Shippo answered 503"), at);
	expect(r).toEqual({
		state: "stale",
		t: known,
		failedAt: at,
		why: "Shippo answered 503",
	});
	expect(knownOf(r)).toBe(known);
});

test("a failure with nothing known is a failure, not no tracking", () => {
	const r = afterFailure(null, new Error("down"), at);
	expect(r).toEqual({ state: "failed", failedAt: at, why: "down" });
	expect(knownOf(r)).toBeNull();
});
