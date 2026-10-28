import { expect, test } from "vitest";
import { ebayObligation, obligationDetail } from "./ebay-case-api";
import {
	CANCELLATION_STATES,
	DISPUTE_STATES,
	ESCALATION_STATES,
	ebayCaseStage,
	INQUIRY_STATES,
} from "./ebay-case-stage";
import { type EbayCaseKind, ebayToMarketplaceCase } from "./ebay-cases";
import { ebayToReturn } from "./ebay-returns";

const expected = {
	inquiry: [
		["OPEN", "open", "us"],
		["PENDING", "processing", "marketplace"],
		["WAITING_SELLER_RESPONSE", "open", "us"],
		["WAITING_BUYER_RESPONSE", "open", "buyer"],
		["CLOSED", "closed", "nobody"],
		["CS_CLOSED", "closed", "nobody"],
		["CLOSED_WITH_ESCALATION", "closed", "nobody"],
		["OTHER", "unknown", "marketplace"],
	],
	cancellation: [
		["APPROVAL_PENDING", "open", "us"],
		["CLOSED", "closed", "nobody"],
		["CONFIRM_REFUND_PENDING", "processing", "buyer"],
		["INITIAL", "unknown", "marketplace"],
		["OTHER", "unknown", "marketplace"],
		["REFUND_FAILED_RETRY", "processing", "marketplace"],
		["REFUND_INITIATED", "processing", "marketplace"],
		["REFUND_PENDING", "processing", "marketplace"],
	],
	escalation: [
		["CLOSED", "closed", "nobody"],
		["CS_CLOSED", "closed", "nobody"],
		["ON_HOLD", "processing", "marketplace"],
		["OPEN", "open", "marketplace"],
		["OTHER", "unknown", "marketplace"],
		["REFUND_AGREED_BUT_FAILED", "processing", "us"],
		["WAITING_CS", "processing", "marketplace"],
		["WAITING_DELIVERY", "processing", "marketplace"],
	],
	dispute: [
		["OPEN", "processing", "marketplace"],
		["ACTION_NEEDED", "open", "us"],
		["CLOSED", "closed", "nobody"],
	],
} as const;
const tables = {
	inquiry: INQUIRY_STATES,
	cancellation: CANCELLATION_STATES,
	escalation: ESCALATION_STATES,
	dispute: DISPUTE_STATES,
};
for (const kind of Object.keys(expected) as EbayCaseKind[]) {
	test(`${kind} states have independent expectations`, () => {
		expect(Object.keys(tables[kind])).toEqual(
			expected[kind].map(([raw]) => raw),
		);
	});
	for (const [raw, status, waitingOn] of expected[kind])
		test(`${kind} ${raw} maps to ${status} / ${waitingOn}`, () => {
			expect(
				ebayCaseStage(kind, raw, { deadline: null, actions: [] }),
			).toMatchObject({ status, waitingOn, respondBy: null });
		});
	test(`${kind} unknown remains explicit`, () => {
		expect(
			ebayCaseStage(kind, "FUTURE_STATE", { deadline: null, actions: [] }),
		).toMatchObject({
			status: "unknown",
			waitingOn: "marketplace",
			respondBy: null,
			problems: [expect.any(String)],
		});
	});
}

test("seller choices and evidence supply ownership and the earliest exact deadline", () => {
	const detail = obligationDetail.parse({
		availableChoices: ["CONTEST"],
		respondByDate: "2026-10-29T12:00:00Z",
		evidenceRequests: [
			{
				evidenceType: "PROOF_OF_DELIVERY",
				respondByDate: "2026-10-28T12:00:00Z",
			},
		],
	});
	expect(
		ebayCaseStage("dispute", "OPEN", ebayObligation(detail)),
	).toMatchObject({
		status: "processing",
		waitingOn: "us",
		respondBy: new Date("2026-10-28T12:00:00Z"),
		nextAction: "CONTEST, Provide PROOF_OF_DELIVERY",
	});
});

test("terminal and buyer states cannot acquire stale seller deadlines", () => {
	const supplied = { deadline: new Date(), actions: ["REFUND"] };
	expect(ebayCaseStage("inquiry", "CLOSED", supplied)).toMatchObject({
		waitingOn: "nobody",
		respondBy: null,
	});
	expect(
		ebayCaseStage("inquiry", "WAITING_BUYER_RESPONSE", supplied),
	).toMatchObject({ waitingOn: "buyer", respondBy: null });
});

test("source conversion keeps an orderless inquiry and does not invent a deadline or URL", () => {
	const mapped = ebayToMarketplaceCase(
		"inquiry",
		{ inquiryId: "I-1", inquiryStatusEnum: "OPEN", creationDate: new Date() },
		{},
	);
	expect(mapped).toMatchObject({
		externalId: "I-1",
		orderExternalId: null,
		status: "open",
		waitingOn: "us",
		respondBy: null,
		actionUrl: null,
	});
});

test("return detail supplies the seller's exact deadline and clears it after closure", () => {
	const source = {
		returnId: "R1",
		orderId: "O1",
		state: "RETURN_REQUESTED",
		creationInfo: { creationDate: { value: new Date() }, item: {} },
	};
	const detail = obligationDetail.parse({
		sellerResponseDue: { respondByDate: { value: "2026-10-28T12:00:00Z" } },
		sellerAvailableOptions: [
			{
				actionType: "ISSUE_REFUND",
				actionURL: "https://www.ebay.com/supplied",
			},
		],
	});
	expect(ebayToReturn(source, detail)).toMatchObject({
		waitingOn: "us",
		respondBy: new Date("2026-10-28T12:00:00Z"),
		nextAction: "ISSUE_REFUND",
	});
	expect(ebayToReturn({ ...source, state: "CLOSED" }, detail)).toMatchObject({
		waitingOn: "nobody",
		respondBy: null,
	});
	expect(
		ebayToReturn({ ...source, state: "ITEM_READY_TO_SHIP" }, detail),
	).toMatchObject({
		waitingOn: "buyer",
		respondBy: null,
	});
});

test("only marketplace-supplied browser pages become case links", () => {
	expect(
		ebayObligation(
			obligationDetail.parse({
				sellerAvailableOptions: [
					{ actionType: "REFUND", actionURL: "https://api.ebay.com/write" },
				],
			}),
		).actionUrl,
	).toBeNull();
	expect(
		ebayObligation(
			obligationDetail.parse({ actionUrl: "https://evil.example/ebay.com" }),
		).actionUrl,
	).toBeNull();
});

test("an escalation date alone may be the buyer's, so it never makes the case ours", () => {
	const due = new Date("2026-10-29T12:00:00Z");
	const detail = obligationDetail.parse({
		respondByDate: due.toISOString(),
	});
	expect(
		ebayCaseStage("escalation", "ON_HOLD", ebayObligation(detail)),
	).toMatchObject({ waitingOn: "marketplace", respondBy: null });
	expect(
		ebayCaseStage("escalation", "ON_HOLD", {
			...ebayObligation(detail),
			actions: ["PROVIDE_PROOF"],
		}),
	).toMatchObject({ waitingOn: "us", respondBy: due });
});
