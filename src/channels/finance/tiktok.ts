import { type } from "arktype";
import type { ReportedCharge } from "#/orders/charges";
import { type ChargeFetcher, eachOrder } from "#/orders/cost-refresh";
import { shopCipher, tiktokApi } from "../tiktok";

// What TikTok charged on an order, from its settlement statement: fees and
// taxes on fees, the label TikTok bought for the order, and refunds. Values
// come signed from TikTok's side, negative being what it kept from us, and
// every breakdown has a total; whatever the named entries don't cover is kept
// as one "other" line, so the charges always add up to TikTok's own totals.
// TikTok only writes a statement once the order settles, a week or more
// after delivery; until then there's nothing to report.

const amount = "string.numeric.parse";
const sku = type({
	fee_tax_amount: amount,
	"fee_tax_breakdown?": {
		"fee?": "Record<string, string>",
		"tax?": "Record<string, string>",
	},
	"shipping_cost_amount?": amount,
	"shipping_cost_breakdown?": "Record<string, unknown>",
	"revenue_breakdown?": "Record<string, string>",
});
const statement = type({ "sku_transactions?": sku.array() });

export type TiktokSkuTransaction = typeof sku.infer;

// The buyer's side of shipping, already on the order as shipping charged.
const BUYER_SHIPPING = "customer_paid_shipping_fee_amount";
// Repeats of other entries: commission before income tax was withheld, and
// money TikTok holds then releases.
const REPEATS = new Set([
	"affiliate_commission_amount_before_pit",
	"affiliate_commission_deposit",
	"affiliate_commission_release",
]);

// "referral_fee_amount" → "Referral fee".
function words(key: string) {
	const text = key.replace(/_amount$/, "").replaceAll("_", " ");
	return text.charAt(0).toUpperCase() + text.slice(1);
}

// An amount TikTok sent that isn't a number fails the order rather than
// counting as nothing.
function money(key: string, value: string) {
	const n = Number(value);
	if (value.trim() === "" || !Number.isFinite(n)) {
		throw new Error(`TikTok sent ${key} as ${JSON.stringify(value)}`);
	}
	return n;
}

function named(
	entries: Record<string, unknown>,
	skip: (key: string) => boolean,
): [string, number][] {
	return Object.entries(entries)
		.filter(([key, value]) => typeof value === "string" && !skip(key))
		.map(
			([key, value]) => [key, money(key, value as string)] as [string, number],
		)
		.filter(([, value]) => value !== 0);
}

function lines(
	kind: ReportedCharge["kind"],
	entries: [string, number][],
	total: number,
	other: string,
): ReportedCharge[] {
	const charges = entries.map(([key, value]) => ({
		kind,
		description: words(key),
		amount: -value,
	}));
	const rest = total - entries.reduce((sum, [, value]) => sum + value, 0);
	if (Math.abs(rest) >= 0.005)
		charges.push({ kind, description: other, amount: -rest });
	return charges;
}

export function tiktokCharges(rows: TiktokSkuTransaction[]): ReportedCharge[] {
	return rows.flatMap((row) => {
		const breakdown = row.fee_tax_breakdown ?? {};
		const fees = lines(
			"fee",
			named({ ...breakdown.fee, ...breakdown.tax }, (k) => REPEATS.has(k)),
			row.fee_tax_amount,
			"Other TikTok fees",
		);
		const shipping = row.shipping_cost_breakdown ?? {};
		const buyerShipping = shipping[BUYER_SHIPPING];
		const buyerPaid =
			typeof buyerShipping === "string"
				? money(BUYER_SHIPPING, buyerShipping)
				: 0;
		const labels = lines(
			"label",
			named(shipping, (k) => k === BUYER_SHIPPING),
			(row.shipping_cost_amount ?? 0) - buyerPaid,
			"Other TikTok shipping",
		);
		const refunds = named(
			row.revenue_breakdown ?? {},
			(k) => !k.includes("refund"),
		).map(
			([key, value]): ReportedCharge => ({
				kind: "refund",
				description: words(key),
				// Refunded amounts are negative revenue.
				amount: -value,
			}),
		);
		return [...fees, ...labels, ...refunds];
	});
}

export const fetchTiktokCharges: ChargeFetcher = eachOrder(async (order) => {
	const data = statement.assert(
		await tiktokApi(
			`/finance/202501/orders/${order.marketplaceId}/statement_transactions`,
			{ shop_cipher: await shopCipher() },
		),
	);
	const rows = data.sku_transactions ?? [];
	if (rows.length === 0) return null;
	return { settled: true, charges: tiktokCharges(rows) };
});
