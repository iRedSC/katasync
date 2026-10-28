import { and, asc, desc, inArray, ne, sql } from "drizzle-orm";
import type { PgColumn } from "drizzle-orm/pg-core";
import {
	type BankTargetSnapshot,
	bankMatches,
	bankMatchParts,
	bankPayoutGuards,
	bankTargetChanges,
	type bankTargetKind,
} from "#/db/banking-schema";
import type { Db } from "#/db/client";
import { payouts } from "#/db/schema";
import { channelName } from "#/lib/format";
import { shopDay } from "./dates";
import { toCents } from "./money";

export type TargetKind = (typeof bankTargetKind.enumValues)[number];

export type TargetRef = { kind: TargetKind; id: number };

export type Observed = BankTargetSnapshot & {
	ref: TargetRef;
	label: string;
	on: string;
	refusal: string | null;
};

export type Window = { currency: string; from: string; to: string };

// Which targets near() gives: every one in the window, or only those a bank
// row of `amountCents` could still take, with some left to match on its side
// of zero. The limit applies after this, so ones it can't take can't crowd
// out the ones it can.
export type NearScope = { kind: "all" } | { kind: "open"; amountCents: number };

export type Near = { observed: Observed[]; truncated: boolean };

export const NEAR_LIMIT = 200;

type Reader = Pick<Db, "select">;

export type MatchTarget = {
	kind: TargetKind;
	partColumn: PgColumn;
	changeColumn: PgColumn;
	lock(tx: Db, ids: number[]): Promise<Observed[]>;
	read(db: Reader, ids: number[]): Promise<Observed[]>;
	near(db: Reader, window: Window, scope: NearScope): Promise<Near>;
	progresses(from: string, to: string): boolean;
};

const payoutFields = {
	id: payouts.id,
	channel: payouts.channel,
	externalId: payouts.externalId,
	status: payouts.status,
	depositedAt: payouts.depositedAt,
	amount: payouts.amount,
	currency: payouts.currency,
	reference: payouts.reference,
};

type PayoutRow = {
	id: number;
	channel: string;
	externalId: string;
	status: string;
	depositedAt: Date;
	amount: number;
	currency: string;
	reference: string | null;
};

const observePayout = (p: PayoutRow): Observed => ({
	ref: { kind: "payout", id: p.id },
	label: `${channelName(p.channel)} payout ${p.externalId}`,
	amountCents: toCents(p.amount),
	currency: p.currency.toUpperCase(),
	status: p.status,
	reference: p.reference,
	on: shopDay(p.depositedAt),
	refusal:
		p.status === "failed"
			? "The marketplace says this payout failed, so it never reached the bank"
			: null,
});

const ids = (rows: number[]) => [...new Set(rows)].sort((a, b) => a - b);

export const payoutTarget: MatchTarget = {
	kind: "payout",
	partColumn: bankMatchParts.payoutId,
	changeColumn: bankTargetChanges.payoutId,
	async lock(tx, wanted) {
		if (wanted.length === 0) return [];
		for (const id of ids(wanted))
			await tx
				.insert(bankPayoutGuards)
				.values({ payoutId: id })
				.onConflictDoUpdate({
					target: bankPayoutGuards.payoutId,
					set: { version: sql`${bankPayoutGuards.version} + 1` },
				});
		const rows = await tx
			.select(payoutFields)
			.from(payouts)
			.where(inArray(payouts.id, ids(wanted)))
			.orderBy(asc(payouts.id))
			.for("update");
		return rows.map(observePayout);
	},
	async read(db, wanted) {
		if (wanted.length === 0) return [];
		const rows = await db
			.select(payoutFields)
			.from(payouts)
			.where(inArray(payouts.id, ids(wanted)));
		return rows.map(observePayout);
	},
	async near(db, w, scope) {
		// What live matches have taken of the payout, as standingOf counts it.
		const allocated = sql`coalesce((
			select sum(${bankMatchParts.amountCents})
			from ${bankMatchParts}
			join ${bankMatches} on ${bankMatches.id} = ${bankMatchParts.matchId}
			where ${bankMatchParts.payoutId} = ${payouts.id}
				and ${bankMatchParts.targetKind} = 'payout'
				and ${bankMatches.undoneAt} is null
		), 0)`;
		const rows = await db
			.select(payoutFields)
			.from(payouts)
			.where(
				and(
					sql`upper(${payouts.currency}) = ${w.currency}`,
					ne(payouts.status, "failed"),
					sql`${payouts.depositedAt} >= (${w.from}::date::timestamp at time zone 'America/New_York')`,
					sql`${payouts.depositedAt} < ((${w.to}::date + 1)::timestamp at time zone 'America/New_York')`,
					scope.kind === "open"
						? sql`sign(round(${payouts.amount} * 100) - ${allocated}) = sign(${scope.amountCents}::bigint)
							and round(${payouts.amount} * 100) <> ${allocated}`
						: undefined,
				),
			)
			// Newest first, so a cut drops the oldest.
			.orderBy(desc(payouts.depositedAt), desc(payouts.id))
			.limit(NEAR_LIMIT + 1);
		return {
			observed: rows.slice(0, NEAR_LIMIT).map(observePayout),
			truncated: rows.length > NEAR_LIMIT,
		};
	},
	progresses: (from, to) => from === "pending" && to === "sent",
};

export const TARGETS: Record<TargetKind, MatchTarget> = {
	payout: payoutTarget,
};

export function partTarget(part: {
	targetKind: TargetKind;
	payoutId: number | null;
}): TargetRef {
	switch (part.targetKind) {
		case "payout":
			if (part.payoutId === null)
				throw new Error("A payout part has no payout");
			return { kind: "payout", id: part.payoutId };
		default: {
			const unreachable: never = part.targetKind;
			return unreachable;
		}
	}
}

export function partColumns(ref: TargetRef) {
	switch (ref.kind) {
		case "payout":
			return { targetKind: ref.kind, payoutId: ref.id };
		default: {
			const unreachable: never = ref.kind;
			return unreachable;
		}
	}
}

export const sameTarget = (a: TargetRef, b: TargetRef) =>
	a.kind === b.kind && a.id === b.id;

export const targetKey = (r: TargetRef) => `${r.kind}:${r.id}`;
