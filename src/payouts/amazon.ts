import { type } from "arktype";
import { spApi } from "#/channels/amazon-api";
import type { FetchedPayout } from "./types";

// Amazon pays out each settlement period as a financial event group. An open
// group is money still building up, not a deposit; a closed one has been sent
// to the bank (FundTransferStatus), or failed to be. Amazon US runs two such
// streams side by side, each with its own groups.

const money = type({ CurrencyCode: "string", CurrencyAmount: "number" });
export const amazonGroup = type({
	FinancialEventGroupId: "string",
	ProcessingStatus: "string",
	"FundTransferStatus?": "string",
	"FundTransferDate?": "string.date.iso.parse",
	"OriginalTotal?": money,
	"TraceId?": "string",
	"AccountTail?": "string",
});
const page = type({
	payload: {
		"FinancialEventGroupList?": amazonGroup.array(),
		"NextToken?": "string",
	},
});

export function amazonPayout(
	g: typeof amazonGroup.infer,
): FetchedPayout | null {
	if (
		g.ProcessingStatus !== "Closed" ||
		!g.FundTransferDate ||
		!g.OriginalTotal
	)
		return null;
	const transfer = g.FundTransferStatus ?? "";
	return {
		externalId: g.FinancialEventGroupId,
		status:
			transfer === "Succeeded"
				? "sent"
				: /fail/i.test(transfer)
					? "failed"
					: "pending",
		depositedAt: g.FundTransferDate,
		amount: g.OriginalTotal.CurrencyAmount,
		currency: g.OriginalTotal.CurrencyCode,
		bankTail: g.AccountTail ?? null,
		reference: g.TraceId ?? null,
	};
}

export async function fetchAmazonPayouts(since: Date) {
	const found: FetchedPayout[] = [];
	let nextToken: string | undefined;
	do {
		const query = nextToken
			? `NextToken=${encodeURIComponent(nextToken)}`
			: `MaxResultsPerPage=100&FinancialEventGroupStartedAfter=${since.toISOString()}`;
		const { payload } = page.assert(
			await spApi(`/finances/v0/financialEventGroups?${query}`),
		);
		for (const g of payload.FinancialEventGroupList ?? []) {
			const p = amazonPayout(g);
			if (p) found.push(p);
		}
		nextToken = payload.NextToken;
	} while (nextToken);
	return found;
}
