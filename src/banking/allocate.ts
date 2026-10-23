import type { BankTargetSnapshot } from "#/db/banking-schema";
import { formatCents, type Parsed } from "./money";
import { type Observed, type TargetRef, targetKey } from "./targets";

export const MAX_PARTS = 20;

export type Proposed = { target: TargetRef; amountCents: number };

export type Standing = Observed & { allocatedCents: number };

export type BankSide = { amountCents: number; currency: string };

export function remainingOf(t: Pick<Standing, "amountCents" | "allocatedCents">) {
	return t.amountCents - t.allocatedCents;
}

export function checkAllocation(
	bank: BankSide,
	parts: readonly Proposed[],
	standing: ReadonlyMap<string, Standing>,
): Parsed<Proposed[]> {
	const money = (c: number) => formatCents(c, bank.currency);
	if (parts.length === 0) return { ok: false, problem: "Pick at least one payout" };
	if (parts.length > MAX_PARTS)
		return { ok: false, problem: `At most ${MAX_PARTS} payouts per deposit` };
	const seen = new Set<string>();
	let total = 0;
	for (const p of parts) {
		const key = targetKey(p.target);
		if (seen.has(key)) return { ok: false, problem: "A payout is picked twice" };
		seen.add(key);
		if (!Number.isSafeInteger(p.amountCents) || p.amountCents === 0)
			return { ok: false, problem: "Every part needs a whole-cent amount" };
		if (Math.sign(p.amountCents) !== Math.sign(bank.amountCents))
			return { ok: false, problem: "A part goes the other way from the bank row" };
		const t = standing.get(key);
		if (!t) return { ok: false, problem: "A picked payout no longer exists" };
		if (t.refusal) return { ok: false, problem: `${t.label}: ${t.refusal}` };
		if (t.currency !== bank.currency)
			return {
				ok: false,
				problem: `${t.label} is in ${t.currency}; the account is ${bank.currency}, and conversion isn't supported`,
			};
		if (Math.sign(t.amountCents) !== Math.sign(bank.amountCents))
			return { ok: false, problem: `${t.label} goes the other way from the bank row` };
		const left = remainingOf(t);
		if (Math.abs(p.amountCents) > Math.abs(left) || Math.sign(left) !== Math.sign(p.amountCents))
			return {
				ok: false,
				problem: `${t.label} has ${money(Math.sign(left) === Math.sign(p.amountCents) ? left : 0)} left to match`,
			};
		total += p.amountCents;
	}
	if (total !== bank.amountCents)
		return {
			ok: false,
			problem: `Parts add to ${money(total)}; the bank row is ${money(bank.amountCents)}`,
		};
	return { ok: true, value: [...parts] };
}

export type Drift =
	| { field: "missing" }
	| { field: "amount"; before: number; after: number }
	| { field: "currency" | "status" | "reference"; before: string | null; after: string | null };

export function driftOf(
	observed: BankTargetSnapshot,
	current: BankTargetSnapshot | null,
	progresses: (from: string, to: string) => boolean,
): Drift[] {
	if (!current) return [{ field: "missing" }];
	const drift: Drift[] = [];
	if (current.amountCents !== observed.amountCents)
		drift.push({ field: "amount", before: observed.amountCents, after: current.amountCents });
	if (current.currency.toUpperCase() !== observed.currency.toUpperCase())
		drift.push({ field: "currency", before: observed.currency, after: current.currency });
	if (current.status !== observed.status && !progresses(observed.status, current.status))
		drift.push({ field: "status", before: observed.status, after: current.status });
	if (observed.reference !== null && current.reference !== observed.reference)
		drift.push({ field: "reference", before: observed.reference, after: current.reference });
	return drift;
}

export function describeDrift(d: Drift, currency: string): string {
	switch (d.field) {
		case "missing":
			return "The payout is gone";
		case "amount":
			return `Amount ${formatCents(d.before, currency)} → ${formatCents(d.after, currency)}`;
		case "currency":
			return `Currency ${d.before} → ${d.after}`;
		case "status":
			return `Status ${d.before} → ${d.after}`;
		case "reference":
			return `Reference ${d.before ?? "none"} → ${d.after ?? "none"}`;
		default: {
			const unreachable: never = d;
			return unreachable;
		}
	}
}
