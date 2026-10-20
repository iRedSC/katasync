import type { SyncedChannel } from "#/diagnostics/checks";
import type { StockChannel } from "../channel";
import { amazonStock } from "./amazon";
import { ebayStock } from "./ebay";
import { shopifyStock } from "./shopify";
import { tiktokStock } from "./tiktok";

// Every synced channel can take stock, so a new channel can't be added
// without saying how.
export const stockChannels: { [C in SyncedChannel]: StockChannel<never> } = {
	shopify: shopifyStock as StockChannel<never>,
	ebay: ebayStock as StockChannel<never>,
	tiktok: tiktokStock as StockChannel<never>,
	amazon: amazonStock as StockChannel<never>,
};
