import type { payouts } from "#/db/schema";

// A payout as a marketplace reports it, ready to save.
export type FetchedPayout = Omit<
	typeof payouts.$inferInsert,
	"id" | "channel" | "fetchedAt"
>;
