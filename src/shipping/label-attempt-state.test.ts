import { describe, expect, test } from "vitest";
import {
	assertTransition,
	fromStates,
	LabelRefused,
	outcomeOf,
	shippoLookup,
} from "./label-attempt-state";

describe("transitions", () => {
	test("final states never move, and nothing goes back to pending", () => {
		expect(() => assertTransition("succeeded", "unknown")).toThrow();
		expect(() => assertTransition("failed", "succeeded")).toThrow();
		expect(() => assertTransition("unknown", "pending")).toThrow();
		expect(() => assertTransition("pending", "unknown")).not.toThrow();
		expect(() => assertTransition("unknown", "unknown")).not.toThrow();
		expect(fromStates("succeeded").sort()).toEqual(["pending", "unknown"]);
	});

	test("only a refusal is a known failure", () => {
		expect(outcomeOf(new LabelRefused("no"))).toBe("failed");
		expect(outcomeOf(new Error("socket hang up"))).toBe("unknown");
		expect(outcomeOf("weird")).toBe("unknown");
	});
});

describe("shippoLookup", () => {
	const tx = (status: string, extra: Record<string, unknown> = {}) => ({
		object_id: `tx-${status}`,
		status,
		label_url: "https://example.com/l.pdf",
		tracking_number: "9400",
		metadata: "a1",
		...extra,
	});

	test("nothing tagged with the attempt is none, which settles nothing", () => {
		expect(shippoLookup("a1", [])).toEqual({ kind: "none" });
		expect(
			shippoLookup("a1", [
				tx("SUCCESS", { metadata: "someone-else" }),
				tx("ERROR", { metadata: null }),
			]),
		).toEqual({ kind: "none" });
	});

	test("the attempt's own label is found, refunded ones found voided", () => {
		expect(shippoLookup("a1", [tx("SUCCESS")])).toMatchObject({
			kind: "bought",
			label: { externalId: "tx-SUCCESS", voided: null },
		});
		expect(shippoLookup("a1", [tx("REFUNDED")])).toMatchObject({
			kind: "bought",
			label: { voided: { refundStatus: "REFUNDED" } },
		});
		expect(shippoLookup("a1", [tx("REFUNDREJECTED")])).toMatchObject({
			label: { voided: null },
		});
	});

	test("only the attempt's own ERROR is a refusal", () => {
		expect(
			shippoLookup("a1", [tx("ERROR", { messages: [{ text: "bad zip" }] })]),
		).toEqual({ kind: "refused", why: "bad zip" });
	});

	test("processing, unfamiliar, or two tagged stay unsure", () => {
		expect(shippoLookup("a1", [tx("QUEUED")]).kind).toBe("pending");
		expect(shippoLookup("a1", [tx("SOMETHING_NEW")]).kind).toBe("pending");
		expect(
			shippoLookup("a1", [tx("SUCCESS"), tx("SUCCESS", { object_id: "b" })])
				.kind,
		).toBe("pending");
	});
});
