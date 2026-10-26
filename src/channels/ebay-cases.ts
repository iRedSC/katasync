import { z } from "zod";
import type { MarketplaceCase } from "#/orders/marketplace-cases";
import {
	ebayCaseGet,
	ebayDate,
	ebayId,
	ebayObligation,
	obligationDetail,
} from "./ebay-case-api";
import { ebayCaseStage } from "./ebay-case-stage";

export type EbayCaseKind =
	| "inquiry"
	| "cancellation"
	| "escalation"
	| "dispute";
const money = z.object({
	value: z.union([z.string(), z.number()]).transform(String),
	currency: z.string().length(3),
});
const record = obligationDetail.extend({
	inquiryId: ebayId.optional(),
	cancelId: ebayId.optional(),
	caseId: ebayId.optional(),
	paymentDisputeId: ebayId.optional(),
	inquiryStatusEnum: z.string().optional(),
	cancelState: z.string().optional(),
	caseStatusEnum: z.string().optional(),
	paymentDisputeStatus: z.string().optional(),
	status: z.string().optional(),
	orderId: z.string().optional(),
	legacyOrderId: z.string().optional(),
	transactionId: ebayId.optional(),
	returnId: ebayId.optional(),
	creationDate: ebayDate.optional(),
	cancelRequestDate: ebayDate.optional(),
	openDate: ebayDate.optional(),
	sellerResponseDueDate: ebayDate.optional(),
	claimAmount: money.optional(),
	requestRefundAmount: money.optional(),
	amount: money.optional(),
});
type Record = z.infer<typeof record>;
const postPage = z.object({
	members: z.array(record).optional(),
	cancellations: z.array(record).optional(),
	paginationOutput: z.object({ totalPages: z.number().int().nonnegative() }),
});
const disputePage = z.object({
	paymentDisputeSummaries: z.array(record),
	next: z.string().optional(),
});
export const CASE_PATHS = {
	inquiry: "inquiry",
	cancellation: "cancellation",
	escalation: "casemanagement",
	dispute: "payment_dispute",
} as const;

export function ebayToMarketplaceCase(
	kind: EbayCaseKind,
	summary: Record,
	detail: Record,
): MarketplaceCase {
	const source = { ...summary, ...detail };
	const externalId =
		summary.inquiryId ??
		summary.cancelId ??
		summary.caseId ??
		summary.paymentDisputeId;
	const rawStatus =
		kind === "inquiry"
			? (detail.status ?? summary.inquiryStatusEnum)
			: kind === "cancellation"
				? source.cancelState
				: kind === "escalation"
					? (detail.status ?? summary.caseStatusEnum)
					: source.paymentDisputeStatus;
	const requestedAt =
		source.creationDate ?? source.cancelRequestDate ?? source.openDate;
	if (!externalId || !rawStatus || !requestedAt)
		throw new Error(`eBay ${kind} missing identity, state or creation date`);
	const supplied = ebayObligation(source);
	if (source.sellerResponseDueDate)
		supplied.deadline = source.sellerResponseDueDate;
	const amount =
		source.claimAmount ?? source.requestRefundAmount ?? source.amount;
	return {
		kind,
		externalId,
		rawStatus,
		requestedAt,
		...ebayCaseStage(kind, rawStatus, supplied),
		orderExternalId: source.orderId ?? source.legacyOrderId ?? null,
		transactionId: source.transactionId ?? null,
		returnExternalId: source.returnId ?? null,
		...(amount
			? { amount: amount.value, currency: amount.currency }
			: { amount: null, currency: null }),
		caseRef: externalId,
		actionUrl: supplied.actionUrl,
	};
}

export async function fetchEbayCase(
	kind: EbayCaseKind,
	externalId: string,
	deadline: number,
	token?: string,
	summary?: Record,
) {
	const path =
		kind === "dispute"
			? `/sell/fulfillment/v1/payment_dispute/${encodeURIComponent(externalId)}`
			: `/post-order/v2/${CASE_PATHS[kind]}/${encodeURIComponent(externalId)}`;
	const response = await ebayCaseGet(
		kind === "cancellation" ? `${path}?fieldgroups=FULL` : path,
		deadline,
		token,
	);
	const wrapped = z.object({ cancelDetail: record }).safeParse(response);
	const detail =
		kind === "cancellation" && wrapped.success
			? wrapped.data.cancelDetail
			: record.parse(response);
	const detailStatus =
		kind === "cancellation"
			? detail.cancelState
			: kind === "dispute"
				? detail.paymentDisputeStatus
				: detail.status;
	if (!detailStatus) throw new Error(`eBay ${kind} detail missing status`);
	const original = summary ?? {
		...detail,
		inquiryId: kind === "inquiry" ? externalId : undefined,
		caseId: kind === "escalation" ? externalId : undefined,
		inquiryStatusEnum: detail.status,
		caseStatusEnum: detail.status,
	};
	return ebayToMarketplaceCase(kind, original, detail);
}

export async function* fetchEbayCases(
	kind: EbayCaseKind,
	from: Date,
	until: Date,
	deadline: number,
	token?: string,
) {
	for (const role of kind === "cancellation"
		? ["BUYER", "SELLER"]
		: [undefined]) {
		yield* fetchCaseSearch(kind, from, until, deadline, token, role);
	}
}

async function* fetchCaseSearch(
	kind: EbayCaseKind,
	from: Date,
	until: Date,
	deadline: number,
	token?: string,
	role?: string,
) {
	const prefix =
		kind === "inquiry" ? "inquiry_" : kind === "escalation" ? "case_" : "";
	for (
		let page = kind === "dispute" || kind === "cancellation" ? 0 : 1;
		;
		page++
	) {
		const params =
			kind === "dispute"
				? new URLSearchParams({
						open_date_from: from.toISOString(),
						open_date_to: until.toISOString(),
						limit: "100",
						offset: String(page * 100),
					})
				: new URLSearchParams({
						[`${prefix}creation_date_range_from`]: from.toISOString(),
						[`${prefix}creation_date_range_to`]: until.toISOString(),
						limit: "100",
						offset: String(kind === "cancellation" ? page * 100 : page),
						...(role ? { role } : {}),
					});
		const path =
			kind === "dispute"
				? "/sell/fulfillment/v1/payment_dispute_summary"
				: `/post-order/v2/${CASE_PATHS[kind]}/search`;
		const response = await ebayCaseGet(`${path}?${params}`, deadline, token);
		if (kind === "dispute") {
			const found = disputePage.parse(response);
			for (const summary of found.paymentDisputeSummaries) {
				if (!summary.paymentDisputeId)
					throw new Error("eBay dispute missing id");
				yield await fetchEbayCase(
					kind,
					summary.paymentDisputeId,
					deadline,
					token,
					summary,
				);
			}
			if (!found.next) return;
		} else {
			const found = postPage.parse(response);
			for (const summary of found.members ?? found.cancellations ?? []) {
				const id = summary.inquiryId ?? summary.cancelId ?? summary.caseId;
				if (!id) throw new Error(`eBay ${kind} missing id`);
				yield await fetchEbayCase(kind, id, deadline, token, summary);
			}
			if (
				(kind === "cancellation" ? page + 1 : page) >=
				found.paginationOutput.totalPages
			)
				return;
		}
	}
}
