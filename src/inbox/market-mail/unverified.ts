import { isRelayed, parseCopy } from "#/buyers/amazon-mail";
import type { Market } from "#/markets/market";

// Why an Amazon buyer message (or Amazon's copy of ours) wasn't put on its
// thread: Microsoft didn't vouch it came from Amazon, so anyone could have
// written it. Null for the rest.
export function unverified(
	e: {
		market: Market | null;
		fromAddress: string;
		senderAuthenticated: boolean;
		subject: string;
		body: string;
	},
	filed: boolean,
) {
	if (filed || e.senderAuthenticated || e.market !== "amazon") return null;
	return isRelayed(e.fromAddress) || parseCopy(e)
		? "Not put on a buyer thread: Microsoft couldn't confirm Amazon sent it"
		: null;
}
