import { z } from "zod";
import { accessToken } from "./ebay";

export const DISPUTE_SCOPE =
	"https://api.ebay.com/oauth/api_scope/sell.payment.dispute";
export class EbayReauthorization extends Error {
	constructor() {
		super(
			"Needs eBay re-authorization: run pnpm ebay:authorize for payment disputes",
		);
	}
}

export async function ebayCaseGet(
	path: string,
	deadline: number,
	disputeToken?: string,
): Promise<unknown> {
	const remaining = deadline - Date.now();
	if (remaining <= 0) throw new Error("eBay cases pass time budget reached");
	const url = new URL(path, "https://api.ebay.com");
	if (
		url.protocol !== "https:" ||
		!["api.ebay.com", "apiz.ebay.com"].includes(url.hostname)
	)
		throw new Error("eBay supplied an unexpected pagination URL");
	const response = await fetch(url, {
		headers: {
			Authorization: `${disputeToken ? "Bearer" : "IAF"} ${disputeToken ?? (await accessToken())}`,
			"X-EBAY-C-MARKETPLACE-ID": "EBAY_US",
		},
		signal: AbortSignal.timeout(
			Math.max(1, Math.min(20_000, deadline - Date.now())),
		),
	});
	if (!response.ok) {
		if (disputeToken && response.status === 403)
			throw new EbayReauthorization();
		throw new Error(`eBay cases ${url.pathname}: HTTP ${response.status}`);
	}
	return response.json();
}

const date = z.iso
	.datetime({ offset: true })
	.transform((value) => new Date(value));
export const ebayDate = z
	.union([date, z.object({ value: date })])
	.transform((value) => (value instanceof Date ? value : value.value));
export const ebayId = z
	.union([z.string().min(1), z.number().int().safe()])
	.transform(String);
const option = z.object({
	actionType: z.string(),
	actionURL: z.string().optional(),
});
export const obligationDetail = z.object({
	sellerAvailableOptions: z.array(option).optional(),
	sellerResponseDue: z
		.object({
			activityDue: z.string().optional(),
			respondByDate: ebayDate.optional(),
		})
		.optional(),
	sellerMakeItRightByDate: ebayDate.optional(),
	respondByDate: ebayDate.optional(),
	availableChoices: z.array(z.string()).optional(),
	evidenceRequests: z
		.array(
			z.object({
				evidenceType: z.string(),
				respondByDate: ebayDate.optional(),
			}),
		)
		.optional(),
	actionUrl: z.string().optional(),
});
export type EbayObligationDetail = z.infer<typeof obligationDetail>;

export function ebayObligation(detail: EbayObligationDetail) {
	const deadlines = [
		detail.sellerResponseDue?.respondByDate,
		detail.respondByDate,
		detail.sellerMakeItRightByDate,
		...(detail.evidenceRequests ?? []).map((request) => request.respondByDate),
	].filter((value): value is Date => value !== undefined);
	return {
		deadline: deadlines.length
			? new Date(Math.min(...deadlines.map((value) => value.getTime())))
			: null,
		actions: [
			...(detail.availableChoices ?? []),
			...(detail.sellerAvailableOptions ?? []).map(
				(option) => option.actionType,
			),
			...(detail.evidenceRequests ?? []).map(
				(request) => `Provide ${request.evidenceType}`,
			),
			...(detail.sellerResponseDue?.activityDue
				? [detail.sellerResponseDue.activityDue]
				: []),
		],
		actionUrl:
			[
				detail.actionUrl,
				...(detail.sellerAvailableOptions ?? []).map(
					(option) => option.actionURL,
				),
			].find((url) => url !== undefined && ebayPageUrl(url)) ?? null,
	};
}

export function ebayPageUrl(value: string): boolean {
	try {
		const url = new URL(value);
		return (
			url.protocol === "https:" &&
			(url.hostname === "www.ebay.com" || url.hostname === "postorder.ebay.com")
		);
	} catch {
		return false;
	}
}
