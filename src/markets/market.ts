import type { channel } from "#/db/schema";

// The marketplaces Markets covers: every channel katasync sells on. Kept
// apart from the queries so the page can use it without them.
export type Market = (typeof channel.enumValues)[number];
export const MARKETS = [
	"shopify",
	"amazon",
	"ebay",
	"tiktok",
] as const satisfies readonly Market[];

// Standing is read again once it's this old. Marketplaces update it about
// daily; this often is plenty.
export const STALE_MS = 6 * 60 * 60 * 1000;
