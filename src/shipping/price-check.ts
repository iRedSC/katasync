// What a buy may spend: the total that was on screen when it was clicked.
// Shared by the server, which refuses a higher confirmed price before any
// label is bought, and quick ship, which shows the new price when it does.

export const PRICE_ROSE = "The price went up";

const cents = (dollars: number) => Math.round(dollars * 100);

// Why these confirmed rates can't be bought at the shown total, or null when
// they can. A lower price is fine.
export function overShown(confirmed: readonly number[], shown: number) {
	const total = confirmed.reduce((sum, cost) => sum + cost, 0);
	return cents(total) > cents(shown)
		? `${PRICE_ROSE} to $${(cents(total) / 100).toFixed(2)}; check it and buy again`
		: null;
}
