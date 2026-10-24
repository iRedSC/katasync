import { and, eq, inArray, isNull } from "drizzle-orm";
import {
	type BankTargetSnapshot,
	bankMatches,
	bankMatchParts,
	bankTargetChanges,
} from "#/db/banking-schema";
import type { Db } from "#/db/client";
import { describeDrift, driftOf, type Standing } from "./allocate";
import { standingOf } from "./matching";
import { partTarget, TARGETS, type TargetRef, targetKey } from "./targets";

export type PartView = {
	target: TargetRef;
	label: string;
	amountCents: number;
	observed: BankTargetSnapshot & { on: string };
	current: Standing | null;
};

export type MatchView = { id: number; matchedAt: string; parts: PartView[] };

export type MatchState =
	| { kind: "unmatched" }
	| { kind: "matched"; match: MatchView }
	| { kind: "needs-review"; match: MatchView; reasons: string[] };

export type MatchEvidence = {
	states: Map<number, MatchState>;
	pastMatches: Map<number, number>;
	targets: Map<string, Standing>;
};

export async function matchStates(
	db: Db,
	ids: readonly number[],
	currency: string,
): Promise<MatchEvidence> {
	const states = new Map<number, MatchState>(
		ids.map((id): [number, MatchState] => [id, { kind: "unmatched" }]),
	);
	const pastMatches = new Map<number, number>();
	if (ids.length === 0) return { states, pastMatches, targets: new Map() };
	const matches = await db
		.select({
			id: bankMatches.id,
			transactionId: bankMatches.transactionId,
			matchedAt: bankMatches.matchedAt,
			undoneAt: bankMatches.undoneAt,
		})
		.from(bankMatches)
		.where(inArray(bankMatches.transactionId, [...ids]));
	const active = matches.filter((m) => m.undoneAt === null);
	for (const m of matches)
		if (m.undoneAt !== null)
			pastMatches.set(
				m.transactionId,
				(pastMatches.get(m.transactionId) ?? 0) + 1,
			);
	const parts =
		active.length === 0
			? []
			: await db
					.select()
					.from(bankMatchParts)
					.where(
						inArray(
							bankMatchParts.matchId,
							active.map((m) => m.id),
						),
					);
	const refs = parts.map(partTarget);
	const targets = await standingOf(db, refs, {
		lock: false,
		excludeMatch: null,
	});
	const payoutIds = refs.filter((r) => r.kind === "payout").map((r) => r.id);
	const changes =
		payoutIds.length === 0
			? []
			: await db
					.select({
						payoutId: bankTargetChanges.payoutId,
						changedAt: bankTargetChanges.changedAt,
						before: bankTargetChanges.before,
						after: bankTargetChanges.after,
					})
					.from(bankTargetChanges)
					.where(
						and(
							eq(bankTargetChanges.targetKind, "payout"),
							inArray(bankTargetChanges.payoutId, payoutIds),
						),
					);
	for (const m of active) {
		const mine = parts.filter((p) => p.matchId === m.id);
		const reasons: string[] = [];
		const views = mine.map((p): PartView => {
			const target = partTarget(p);
			const current = targets.get(targetKey(target)) ?? null;
			const observed = {
				amountCents: p.observedAmountCents,
				currency: p.observedCurrency,
				status: p.observedStatus,
				reference: p.observedReference,
				on: p.observedOn,
			};
			const { progresses } = TARGETS[target.kind];
			const drift = driftOf(observed, current, progresses);
			const label = current?.label ?? `${target.kind} ${target.id}`;
			for (const d of drift)
				reasons.push(`${label}: ${describeDrift(d, currency)}`);
			const flipped =
				drift.length === 0 &&
				changes.some(
					(c) =>
						target.kind === "payout" &&
						c.payoutId === target.id &&
						c.changedAt > m.matchedAt &&
						driftOf(c.before, c.after, progresses).length > 0,
				);
			if (flipped)
				reasons.push(`${label}: changed after the match, then changed back`);
			return { target, label, amountCents: p.amountCents, observed, current };
		});
		const match = {
			id: m.id,
			matchedAt: m.matchedAt.toISOString(),
			parts: views,
		};
		states.set(
			m.transactionId,
			reasons.length > 0
				? { kind: "needs-review", match, reasons }
				: { kind: "matched", match },
		);
	}
	return { states, pastMatches, targets };
}

export type BankState = "none" | "partial" | "matched" | "needs-review";

export async function reviewingTargets(
	db: Db,
	refs: readonly TargetRef[],
	currency: string,
): Promise<Set<string>> {
	const payoutIds = refs.map((ref) => ref.id);
	if (payoutIds.length === 0) return new Set();
	const contributors = await db
		.selectDistinct({ transactionId: bankMatches.transactionId })
		.from(bankMatches)
		.innerJoin(bankMatchParts, eq(bankMatchParts.matchId, bankMatches.id))
		.where(
			and(
				inArray(bankMatchParts.payoutId, payoutIds),
				isNull(bankMatches.undoneAt),
			),
		);
	const all = await matchStates(
		db,
		contributors.map((match) => match.transactionId),
		currency,
	);
	return new Set(
		[...all.states.values()].flatMap((state) =>
			state.kind === "needs-review"
				? state.match.parts.map((part) => targetKey(part.target))
				: [],
		),
	);
}

export function bankStateOf(
	t: Standing,
	reviewing: ReadonlySet<string>,
): BankState {
	if (reviewing.has(targetKey(t.ref))) return "needs-review";
	if (t.allocatedCents === 0) return "none";
	return t.allocatedCents === t.amountCents ? "matched" : "partial";
}
