import { describe, expect, test } from "vitest";
import {
	TIKTOK_AFTERSALES_STATES,
	type TIKTOK_ARBITRATION_STATES,
	type TIKTOK_RETURN_STATES,
	TIKTOK_RMA_STATES,
	tiktokReturnStage,
} from "./tiktok-case-stage";

const expected = {
	RETURN_OR_REFUND_REQUEST_PENDING: ["requested", "us"],
	REFUND_OR_RETURN_REQUEST_REJECT: ["cancelled", "nobody"],
	AWAITING_BUYER_SHIP: ["requested", "buyer"],
	BUYER_SHIPPED_ITEM: ["shipped", "marketplace"],
	REJECT_RECEIVE_PACKAGE: ["cancelled", "nobody"],
	RETURN_OR_REFUND_REQUEST_SUCCESS: ["processing", "marketplace"],
	RETURN_OR_REFUND_REQUEST_CANCEL: ["cancelled", "nobody"],
	RETURN_OR_REFUND_REQUEST_COMPLETE: ["closed", "nobody"],
	AWAITING_BUYER_RESPONSE: ["requested", "buyer"],
	REPLACEMENT_REQUEST_PENDING: ["requested", "us"],
	REPLACEMENT_REQUEST_REJECT: ["cancelled", "nobody"],
	REPLACEMENT_REQUEST_REFUND_SUCCESS: ["processing", "marketplace"],
	REPLACEMENT_REQUEST_CANCEL: ["cancelled", "nobody"],
	REPLACEMENT_REQUEST_COMPLETE: ["closed", "nobody"],
	EXCHANGE_REQUEST_PENDING: ["requested", "us"],
	EXCHANGE_REQUEST_REFUND_SUCCESS: ["processing", "marketplace"],
	EXCHANGE_REQUEST_CANCEL: ["cancelled", "nobody"],
	EXCHANGE_REQUEST_COMPLETE: ["closed", "nobody"],
} as const satisfies Record<
	keyof typeof TIKTOK_RETURN_STATES,
	readonly [string, string]
>;

describe("TikTok case mapping", () => {
	test.each(Object.entries(expected))("%s", (return_status, [
		status,
		waitingOn,
	]) => {
		expect(tiktokReturnStage({ return_status })).toEqual({
			kind: "return",
			status,
			waitingOn,
			respondBy: null,
			escalation: null,
			problems: [],
		});
	});
	test("an unrecognized value stays unknown, with seller ownership only for a supplied action", () => {
		const input = {
			return_status: "FUTURE_SUCCESS",
			afterSalesStatus: "PENDING_REQUEST_REVIEW",
		};
		expect(tiktokReturnStage(input)).toMatchObject({
			status: "unknown",
			waitingOn: "marketplace",
			problems: ["Unknown TikTok return status: FUTURE_SUCCESS"],
		});
		expect(
			tiktokReturnStage({
				...input,
				seller_next_action_response: [
					{ action: "RESPOND", deadline: 1793037279 },
				],
			}),
		).toMatchObject({
			status: "unknown",
			waitingOn: "us",
			respondBy: new Date("2026-10-26T17:54:39Z"),
		});
	});
	test("refund approval is not settlement and omitted deadlines are never guessed", () => {
		expect(
			tiktokReturnStage({
				return_status: "RETURN_OR_REFUND_REQUEST_SUCCESS",
				return_type: "REFUND",
			}),
		).toMatchObject({
			kind: "refund",
			status: "processing",
			waitingOn: "marketplace",
			respondBy: null,
		});
		expect(
			tiktokReturnStage({
				return_status: "RETURN_OR_REFUND_REQUEST_PENDING",
				seller_next_action_response: [{ action: "RESPOND" }],
			}),
		).toMatchObject({ waitingOn: "us", respondBy: null });
	});
	test.each([
		["INIT", "processing", "marketplace"],
		["PENDING_REQUEST_REVIEW", "requested", "us"],
		["REQUEST_REVIEW_COMPLETED", "requested", "us"],
	] as const)("parent %s does not invent settlement", (afterSalesStatus, status, waitingOn) => {
		expect(
			tiktokReturnStage({
				return_status: "RETURN_OR_REFUND_REQUEST_PENDING",
				afterSalesStatus,
			}),
		).toMatchObject({ status, waitingOn });
	});
	test.each([
		["INIT", "processing", "marketplace"],
		["AWAITING_BUYER_RETURN", "requested", "buyer"],
		["RETURN_IN_TRANSIT", "shipped", "marketplace"],
		["PENDING_PACKAGE_REVIEW", "delivered", "us"],
		["PACKAGE_REVIEW_COMPLETED", "requested", "us"],
	] as const)("RMA %s", (rmaStatus, status, waitingOn) => {
		expect(
			tiktokReturnStage({
				return_status: "RETURN_OR_REFUND_REQUEST_PENDING",
				rmaStatus,
			}),
		).toMatchObject({ status, waitingOn });
	});
	test("parent and RMA enum additions require coverage", () => {
		expect(TIKTOK_AFTERSALES_STATES).toEqual([
			"INIT",
			"PENDING_REQUEST_REVIEW",
			"REQUEST_REVIEW_COMPLETED",
		]);
		expect(TIKTOK_RMA_STATES).toEqual([
			"INIT",
			"AWAITING_BUYER_RETURN",
			"RETURN_IN_TRANSIT",
			"PENDING_PACKAGE_REVIEW",
			"PACKAGE_REVIEW_COMPLETED",
		]);
	});
	test.each(
		Object.entries({
			IN_PROGRESS: "in_progress",
			SUPPORT_BUYER: "buyer_won",
			SUPPORT_SELLER: "seller_won",
			CLOSED: "closed",
		} satisfies Record<keyof typeof TIKTOK_ARBITRATION_STATES, string>),
	)("arbitration %s", (arbitration_status, escalation) => {
		expect(
			tiktokReturnStage({
				return_status: "RETURN_OR_REFUND_REQUEST_COMPLETE",
				arbitration_status,
			}),
		).toMatchObject({
			escalation,
			waitingOn: escalation === "in_progress" ? "marketplace" : "nobody",
			status: escalation === "in_progress" ? "processing" : "closed",
		});
	});
	test("seller evidence deadlines survive arbitration and use the earliest supplied action", () => {
		expect(
			tiktokReturnStage({
				return_status: "RETURN_OR_REFUND_REQUEST_COMPLETE",
				arbitration_status: "IN_PROGRESS",
				seller_next_action_response: [
					{ action: "EVIDENCE", deadline: 1793164840 },
					{ action: "RESPOND", deadline: 1793037279 },
				],
			}),
		).toMatchObject({
			status: "processing",
			waitingOn: "us",
			escalation: "in_progress",
			respondBy: new Date("2026-10-26T17:54:39Z"),
		});
	});
	test("settled SKU money does not hide an outstanding parent or package obligation", () => {
		expect(
			tiktokReturnStage({
				return_status: "RETURN_OR_REFUND_REQUEST_COMPLETE",
				afterSalesStatus: "PENDING_REQUEST_REVIEW",
			}),
		).toMatchObject({ status: "processing", waitingOn: "us", respondBy: null });
		expect(
			tiktokReturnStage({
				return_status: "RETURN_OR_REFUND_REQUEST_COMPLETE",
				rmaStatus: "PENDING_PACKAGE_REVIEW",
			}),
		).toMatchObject({ status: "delivered", waitingOn: "us", respondBy: null });
	});
	test.each([
		{ afterSalesStatus: "FUTURE_PARENT" },
		{ rmaStatus: "FUTURE_RMA" },
		{ arbitration_status: "FUTURE_ARBITRATION" },
	])("unknown dimensions cannot resolve a case: %o", (extra) => {
		const mapped = tiktokReturnStage({
			return_status: "RETURN_OR_REFUND_REQUEST_COMPLETE",
			...extra,
		});
		expect(mapped.waitingOn).toBe("marketplace");
		expect(mapped.problems).toHaveLength(1);
	});
});
