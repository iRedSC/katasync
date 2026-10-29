import { describe, expect, test } from "vitest";
import {
	returnSituation,
	type SituationInput,
	type SituationRequest,
} from "./return-situation";

const amazon = {
	channel: "amazon" as const,
	name: "Amazon",
	url: "https://sellercentral.amazon.com/x",
};

const request = (r: Partial<SituationRequest> = {}): SituationRequest => ({
	billedBy: "amazon",
	status: "shipped",
	waitingOn: "marketplace",
	amount: null,
	currency: null,
	deliveredAt: null,
	tracking: null,
	answerOn: amazon,
	...r,
});

const situation = (o: Partial<SituationInput>) =>
	returnSituation({
		state: null,
		noReturnAt: null,
		requests: [],
		back: null,
		refunded: 0,
		...o,
	});

const at = new Date("2026-10-20T12:00:00Z");

describe("returnSituation", () => {
	test("a package the carrier delivered is ours to check in", () => {
		const s = situation({
			state: "on_its_way",
			requests: [
				request({
					tracking: { status: "DELIVERED", statusAt: at, eta: null },
				}),
			],
		});
		expect(s.item).toEqual({ kind: "arrived", at });
		expect(s.next).toEqual({ kind: "check_in" });
	});

	test("Amazon saying delivered is enough, even refunded and not back", () => {
		const s = situation({
			state: "refunded",
			requests: [request({ status: "delivered", waitingOn: "us" })],
		});
		expect(s.item).toEqual({ kind: "arrived", at: null });
		expect(s.next.kind).toBe("check_in");
	});

	test("in transit waits on the carrier; not shipped waits on the buyer", () => {
		expect(situation({ state: "on_its_way", requests: [request()] })).toEqual({
			item: { kind: "coming", tracking: null },
			refund: { kind: "none" },
			next: { kind: "in_transit" },
		});
		expect(
			situation({
				state: "requested",
				requests: [request({ status: "requested", waitingOn: "buyer" })],
			}).next,
		).toEqual({ kind: "with_buyer" });
	});

	test("a request waiting on our answer asks for one", () => {
		const s = situation({
			state: "requested",
			requests: [request({ status: "requested", waitingOn: "us" })],
		});
		expect(s.next).toEqual({ kind: "answer", on: amazon });
	});

	test("back here with no refund seen is ours to refund", () => {
		const s = situation({
			requests: [request({ status: "delivered", waitingOn: "us" })],
			back: { quantity: 1, at, outcome: "restocked" },
		});
		expect(s.item).toEqual({
			kind: "back",
			quantity: 1,
			at,
			outcome: "restocked",
		});
		expect(s.next).toEqual({ kind: "refund", on: amazon });
	});

	test("counted at cutover never asks for a refund, only to close", () => {
		const s = situation({
			requests: [request()],
			back: { quantity: 1, at, outcome: "counted" },
		});
		expect(s.refund).toEqual({ kind: "none" });
		expect(s.next).toEqual({ kind: "close", on: amazon });
	});

	test("an open return nothing's due for still says where it is", () => {
		expect(situation({ requests: [request()] })).toMatchObject({
			item: { kind: "coming" },
			next: { kind: "in_transit" },
		});
		expect(
			situation({ requests: [request({ status: "delivered" })] }).next,
		).toEqual({ kind: "check_in" });
	});

	test("back and refunded, the marketplace only has it left open", () => {
		const s = situation({
			requests: [request({ status: "delivered", waitingOn: "us" })],
			back: { quantity: 1, at, outcome: "counted" },
			refunded: 221.71,
		});
		expect(s.refund).toEqual({
			kind: "refunded",
			amount: { amount: 221.71, currency: "USD" },
		});
		expect(s.next).toEqual({ kind: "close", on: amazon });
	});

	test("Amazon's amount is what it refunded; TikTok's is what was asked", () => {
		expect(
			situation({
				state: "on_its_way",
				requests: [request({ amount: "54.26", currency: "USD" })],
			}).refund,
		).toEqual({ kind: "refunded", amount: { amount: 54.26, currency: "USD" } });
		expect(
			situation({
				state: "on_its_way",
				requests: [
					request({ billedBy: "tiktok", amount: "22.84", currency: "USD" }),
				],
			}).refund,
		).toEqual({ kind: "asked", amount: { amount: 22.84, currency: "USD" } });
	});

	test("refunded but not back, or maybe coming, is ours to decide", () => {
		expect(situation({ state: "refunded" }).next.kind).toBe("decide");
		expect(situation({ state: "maybe", refunded: 5 }).next.kind).toBe("decide");
	});

	test("nothing coming with the marketplace still open is left to close", () => {
		const s = situation({
			noReturnAt: at,
			requests: [request({ status: "delivered", waitingOn: "us" })],
			refunded: 174,
		});
		expect(s.item).toEqual({ kind: "not_coming" });
		expect(s.next.kind).toBe("close");
	});

	test("back with nothing open on the marketplace is done", () => {
		expect(
			situation({ back: { quantity: 1, at, outcome: "written_off" } }).next,
		).toEqual({ kind: "done" });
	});
});
