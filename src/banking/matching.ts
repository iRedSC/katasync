import { and, eq, inArray, isNull, ne, sql } from "drizzle-orm";
import { bankMatches, bankMatchParts, bankTransactions } from "#/db/banking-schema";
import type { Db } from "#/db/client";
import { checkAllocation, type Proposed, type Standing } from "./allocate";
import type { Parsed } from "./money";
import {
	type Observed,
	partColumns,
	partTarget,
	TARGETS,
	type TargetKind,
	type TargetRef,
	targetKey,
} from "./targets";

export async function standingOf(
	db: Db,
	refs: readonly TargetRef[],
	{ lock, excludeMatch }: { lock: boolean; excludeMatch: number | null },
): Promise<Map<string, Standing>> {
	const out = new Map<string, Standing>();
	const byKind = new Map<TargetKind, number[]>();
	for (const r of refs) byKind.set(r.kind, [...(byKind.get(r.kind) ?? []), r.id]);
	for (const [kind, ids] of byKind) {
		const target = TARGETS[kind];
		const observed: Observed[] = lock ? await target.lock(db, ids) : await target.read(db, ids);
		const sums = await db
			.select({
				id: sql<number>`${target.partColumn}`,
				total: sql<string>`sum(${bankMatchParts.amountCents})`,
			})
			.from(bankMatchParts)
			.innerJoin(bankMatches, eq(bankMatches.id, bankMatchParts.matchId))
			.where(
				and(
					eq(bankMatchParts.targetKind, kind),
					inArray(target.partColumn, ids),
					isNull(bankMatches.undoneAt),
					excludeMatch === null ? undefined : ne(bankMatches.id, excludeMatch),
				),
			)
			.groupBy(target.partColumn);
		const allocated = new Map(sums.map((s) => [Number(s.id), Number(s.total)]));
		for (const o of observed)
			out.set(targetKey(o.ref), { ...o, allocatedCents: allocated.get(o.ref.id) ?? 0 });
	}
	return out;
}

export type MatchPart = Proposed & { matchId: number };

export async function partsOf(db: Db, matchIds: readonly number[]): Promise<MatchPart[]> {
	if (matchIds.length === 0) return [];
	const rows = await db
		.select({
			matchId: bankMatchParts.matchId,
			targetKind: bankMatchParts.targetKind,
			payoutId: bankMatchParts.payoutId,
			amountCents: bankMatchParts.amountCents,
		})
		.from(bankMatchParts)
		.where(inArray(bankMatchParts.matchId, [...matchIds]));
	return rows.map((r) => ({ matchId: r.matchId, target: partTarget(r), amountCents: r.amountCents }));
}

const sameParts = (a: readonly Proposed[], b: readonly Proposed[]) => {
	const key = (p: Proposed) => `${targetKey(p.target)}=${p.amountCents}`;
	const left = new Set(a.map(key));
	return a.length === b.length && left.size === a.length && b.every((p) => left.has(key(p)));
};

export type Confirmed = { kind: "matched" | "already"; matchId: number };

export async function confirmMatch(
	db: Db,
	input: { transactionId: number; parts: readonly Proposed[]; replaces: number | null },
): Promise<Parsed<Confirmed>> {
	return db.transaction(async (tx) => {
		const [bank] = await tx
			.select({
				id: bankTransactions.id,
				amountCents: bankTransactions.amountCents,
				currency: bankTransactions.currency,
			})
			.from(bankTransactions)
			.where(eq(bankTransactions.id, input.transactionId))
			.for("update");
		if (!bank) return { ok: false, problem: "That bank row doesn't exist" };
		const [active] = await tx
			.select({ id: bankMatches.id })
			.from(bankMatches)
			.where(and(eq(bankMatches.transactionId, bank.id), isNull(bankMatches.undoneAt)));
		if (input.replaces !== null && active?.id !== input.replaces)
			return { ok: false, problem: "This bank row's match changed since you opened it" };
		if (input.replaces === null && active) {
			const current = await partsOf(tx, [active.id]);
			if (sameParts(current, input.parts))
				return { ok: true, value: { kind: "already", matchId: active.id } };
			return { ok: false, problem: "This bank row is already matched; undo that first" };
		}
		const standing = await standingOf(
			tx,
			input.parts.map((p) => p.target),
			{ lock: true, excludeMatch: input.replaces },
		);
		const checked = checkAllocation(bank, input.parts, standing);
		if (!checked.ok) return checked;
		if (input.replaces !== null) {
			const undone = await tx
				.update(bankMatches)
				.set({ undoneAt: sql`clock_timestamp()` })
				.where(and(eq(bankMatches.id, input.replaces), isNull(bankMatches.undoneAt)))
				.returning({ id: bankMatches.id });
			if (undone.length !== 1) throw new Error("The match being replaced was already undone");
		}
		const [made] = await tx
			.insert(bankMatches)
			.values({ transactionId: bank.id, replaces: input.replaces })
			.returning({ id: bankMatches.id });
		await tx.insert(bankMatchParts).values(
			checked.value.map((p) => {
				const seen = standing.get(targetKey(p.target));
				if (!seen) throw new Error("A checked part lost its payout");
				return {
					matchId: made.id,
					...partColumns(p.target),
					amountCents: p.amountCents,
					observedAmountCents: seen.amountCents,
					observedCurrency: seen.currency,
					observedStatus: seen.status,
					observedReference: seen.reference,
					observedOn: seen.on,
				};
			}),
		);
		return { ok: true, value: { kind: "matched", matchId: made.id } };
	});
}

export type Undone =
	| { kind: "undone"; transactionId: number; parts: Proposed[] }
	| { kind: "already"; transactionId: number; parts: Proposed[] };

export async function undoMatch(db: Db, matchId: number): Promise<Parsed<Undone>> {
	return db.transaction(async (tx) => {
		const [match] = await tx
			.select({ transactionId: bankMatches.transactionId })
			.from(bankMatches)
			.where(eq(bankMatches.id, matchId));
		if (!match) return { ok: false, problem: "That match doesn't exist" };
		const undone = await tx
			.update(bankMatches)
			.set({ undoneAt: sql`clock_timestamp()` })
			.where(and(eq(bankMatches.id, matchId), isNull(bankMatches.undoneAt)))
			.returning({ id: bankMatches.id });
		const parts = (await partsOf(tx, [matchId])).map(({ target, amountCents }) => ({ target, amountCents }));
		return {
			ok: true,
			value: { kind: undone.length === 1 ? "undone" : "already", transactionId: match.transactionId, parts },
		};
	});
}
