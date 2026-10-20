// What Settings says about one store's stock push, worked out in one place so
// each state reads one way.

export type StockPushRow = {
	on: boolean;
	pushedAt: Date | string | null;
	error: string | null;
	// Every listing katasync has for the store, mapped or not.
	listed: number;
	mapped: number;
	ready: number;
	failing: number;
};

export type StockPushStatus =
	| { kind: "off" }
	// On, but katasync's numbers can't be trusted yet (see stockBlocker).
	| { kind: "blocked"; why: string }
	// On, and the last pass failed before reaching the channel.
	| { kind: "stopped"; why: string }
	// On, but katasync has none of the store's listings, so there's nothing
	// to set. Its listings sync is failing or hasn't run.
	| { kind: "unlisted" }
	// On, off production: passes only work out what they'd set.
	| { kind: "preview" }
	// On, waiting for its first pass.
	| { kind: "starting" }
	| {
			kind: "pushing";
			pushedAt: Date;
			// Mapped listings katasync can set, of all mapped ones.
			ready: number;
			mapped: number;
			failing: number;
	  };

export function stockPushStatus(
	row: StockPushRow,
	context: { writes: boolean; blocker: string | null },
): StockPushStatus {
	if (!row.on) return { kind: "off" };
	if (context.blocker) return { kind: "blocked", why: context.blocker };
	if (row.error) return { kind: "stopped", why: row.error };
	if (row.listed === 0) return { kind: "unlisted" };
	if (!context.writes) return { kind: "preview" };
	if (!row.pushedAt) return { kind: "starting" };
	return {
		kind: "pushing",
		pushedAt: new Date(row.pushedAt),
		ready: row.ready,
		mapped: row.mapped,
		failing: row.failing,
	};
}
