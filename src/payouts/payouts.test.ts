import { describe, expect, it } from "vitest";
import { amazonGroup, amazonPayout } from "./amazon";
import { ebayPayout, ebayToPayout } from "./ebay";
import { shopifyPayout, shopifyToPayout } from "./shopify";
import { tiktokPayment, tiktokPayout } from "./tiktok";

// Shapes as each marketplace sent them, trimmed.

describe("amazonPayout", () => {
	const closed = amazonGroup.assert({
		FinancialEventGroupId: "Tmuf",
		ProcessingStatus: "Closed",
		FundTransferStatus: "Succeeded",
		OriginalTotal: { CurrencyCode: "USD", CurrencyAmount: 2054.75 },
		FundTransferDate: "2026-10-09T19:36:47Z",
		TraceId: "60S17855GR2OJBR",
		AccountTail: "174",
	});

	it("reads a closed group as a deposit, with the trace ID the bank shows", () => {
		expect(amazonPayout(closed)).toEqual({
			externalId: "Tmuf",
			status: "sent",
			depositedAt: new Date("2026-10-09T19:36:47Z"),
			amount: 2054.75,
			currency: "USD",
			bankTail: "174",
			reference: "60S17855GR2OJBR",
		});
	});

	it("leaves out a group still open: nothing has been sent yet", () => {
		expect(
			amazonPayout(
				amazonGroup.assert({
					FinancialEventGroupId: "zt",
					ProcessingStatus: "Open",
					OriginalTotal: { CurrencyCode: "USD", CurrencyAmount: 322.15 },
				}),
			),
		).toBeNull();
	});
});

describe("ebayToPayout", () => {
	it("reads the amount, bank and the bank's reference", () => {
		const p = ebayToPayout(
			ebayPayout.assert({
				payoutId: "7804457811",
				payoutStatus: "SUCCEEDED",
				amount: { value: "3484.32", currency: "USD" },
				payoutDate: "2026-10-20T11:54:19.000Z",
				payoutInstrument: { accountLastFourDigits: "8174" },
				bankReference: "9XAOSHVQ0MZ0O6D",
			}),
		);
		expect(p).toMatchObject({
			status: "sent",
			amount: 3484.32,
			bankTail: "8174",
			reference: "9XAOSHVQ0MZ0O6D",
		});
	});

	it("counts a reversed payout as failed and an initiated one as on its way", () => {
		const base = {
			payoutId: "1",
			amount: { value: "1", currency: "USD" },
			payoutDate: "2026-10-20T00:00:00.000Z",
		};
		expect(
			ebayToPayout(ebayPayout.assert({ ...base, payoutStatus: "REVERSED" }))
				.status,
		).toBe("failed");
		expect(
			ebayToPayout(ebayPayout.assert({ ...base, payoutStatus: "INITIATED" }))
				.status,
		).toBe("pending");
	});
});

describe("tiktokPayout", () => {
	it("dates a payment by when it was paid, and keeps only the visible digits", () => {
		const p = tiktokPayout(
			tiktokPayment.assert({
				id: "3489808907219080122",
				status: "PAID",
				create_time: 1791528372,
				paid_time: 1791528463,
				amount: { value: "5840.2", currency: "USD" },
				bank_account: "********8174",
			}),
		);
		expect(p).toMatchObject({
			status: "sent",
			depositedAt: new Date(1791528463 * 1000),
			amount: 5840.2,
			bankTail: "8174",
		});
	});
});

describe("shopifyToPayout", () => {
	const payout = (status: string) =>
		shopifyPayout.assert({
			id: "gid://shopify/ShopifyPaymentsPayout/1",
			issuedAt: "2026-10-01T00:00:00Z",
			status,
			net: { amount: "120.50", currencyCode: "USD" },
		});

	it("reads a paid payout", () => {
		expect(shopifyToPayout(payout("PAID"))).toMatchObject({
			status: "sent",
			amount: 120.5,
		});
	});

	it("leaves out a cancelled one: it never went", () => {
		expect(shopifyToPayout(payout("CANCELED"))).toBeNull();
	});
});
