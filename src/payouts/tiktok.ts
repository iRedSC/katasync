import { type } from "arktype";
import { shopCipher, tiktokApi } from "#/channels/tiktok";
import type { FetchedPayout } from "./types";

// TikTok's payments: money it sent, or is sending, to the bank.

export const tiktokPayment = type({
	id: "string",
	status: "string",
	create_time: "number",
	"paid_time?": "number",
	amount: { value: "string.numeric.parse", currency: "string" },
	"bank_account?": "string",
});
const page = type({
	"payments?": tiktokPayment.array(),
	"next_page_token?": "string",
});

export function tiktokPayout(p: typeof tiktokPayment.infer): FetchedPayout {
	return {
		externalId: p.id,
		status:
			p.status === "PAID"
				? "sent"
				: p.status === "FAILED"
					? "failed"
					: "pending",
		depositedAt: new Date((p.paid_time ?? p.create_time) * 1000),
		amount: p.amount.value,
		currency: p.amount.currency,
		// TikTok masks all but the last four: "********8174".
		bankTail: p.bank_account?.replace(/^\*+/, "") || null,
		reference: null,
	};
}

export async function fetchTiktokPayouts(since: Date) {
	const cipher = await shopCipher();
	const found: FetchedPayout[] = [];
	let token: string | undefined;
	do {
		const data = page.assert(
			await tiktokApi("/finance/202309/payments", {
				shop_cipher: cipher,
				create_time_ge: String(Math.floor(since.getTime() / 1000)),
				create_time_lt: String(Math.floor(Date.now() / 1000)),
				sort_field: "create_time",
				page_size: "100",
				...(token ? { page_token: token } : {}),
			}),
		);
		found.push(...(data.payments ?? []).map(tiktokPayout));
		token = data.next_page_token || undefined;
	} while (token);
	return found;
}
