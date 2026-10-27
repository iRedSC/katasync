import type { Market } from "#/markets/market";

// Which marketplace an address belongs to, by its domain: one of these or a
// subdomain of one (marketplace.amazon.com is Amazon's). A domain that only
// starts with one (amazon.attacker.com, amazon.com.attacker.com) belongs to
// whoever registered it, so it's no marketplace's.
const DOMAINS: Record<Market, readonly string[]> = {
	amazon: [
		"amazon.com",
		"amazon.ca",
		"amazon.com.mx",
		"amazon.co.uk",
		"amazon.de",
		"amazon.fr",
		"amazon.it",
		"amazon.es",
		"amazon.co.jp",
		"amazon.com.au",
		"amazon.com.br",
		"amazon.in",
		"amazon.nl",
		"amazon.se",
		"amazon.pl",
		"amazon.com.be",
		"amazon.ie",
		"amazon.com.tr",
		"amazon.ae",
		"amazon.sa",
		"amazon.eg",
		"amazon.sg",
	],
	ebay: [
		"ebay.com",
		"ebay.ca",
		"ebay.co.uk",
		"ebay.com.au",
		"ebay.de",
		"ebay.fr",
		"ebay.it",
		"ebay.es",
		"ebay.at",
		"ebay.ch",
		"ebay.ie",
		"ebay.nl",
		"ebay.be",
		"ebay.pl",
	],
	tiktok: ["tiktok.com", "tiktokshop.com", "tiktokglobalshop.com"],
	shopify: ["shopify.com"],
};

// The domain of an address, lowercased; null when it has none.
export function domainOf(address: string) {
	const a = address.trim().toLowerCase();
	const at = a.lastIndexOf("@");
	return at < 0 || at === a.length - 1 ? null : a.slice(at + 1);
}

const under = (domain: string, approved: string) =>
	domain === approved || domain.endsWith(`.${approved}`);

export function marketOf(fromAddress: string): Market | null {
	const domain = domainOf(fromAddress);
	if (!domain) return null;
	for (const [market, domains] of Object.entries(DOMAINS) as [
		Market,
		readonly string[],
	][])
		if (domains.some((d) => under(domain, d))) return market;
	return null;
}

// Amazon's own, whatever was stored for the email when it arrived.
export function isAmazonAddress(fromAddress: string) {
	return marketOf(fromAddress) === "amazon";
}
