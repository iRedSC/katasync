import { type Proposed, remainingOf, type Standing } from "./allocate";
import { daysBetween } from "./dates";

export type BankRow = {
	amountCents: number;
	currency: string;
	postedOn: string;
	description: string;
};

export type Suggestion = {
	parts: Proposed[];
	days: number;
	referenced: boolean;
};

export type Suggestions = { suggestions: Suggestion[]; ambiguous: boolean };

const POOL = 12;
const MAX_COMBINED = 3;
export const WINDOW_DAYS = { before: 10, after: 4 };

export function usable(bank: BankRow, t: Standing) {
	const left = remainingOf(t);
	return (
		t.refusal === null &&
		t.currency === bank.currency &&
		left !== 0 &&
		Math.sign(left) === Math.sign(bank.amountCents)
	);
}

function mentions(description: string, t: Standing) {
	const ref = t.reference?.trim().toLowerCase();
	return Boolean(
		ref && ref.length >= 4 && description.toLowerCase().includes(ref),
	);
}

export function suggest(
	bank: BankRow,
	candidates: readonly Standing[],
): Suggestions {
	const pool = candidates
		.filter((t) => usable(bank, t))
		.map((t) => ({ t, days: Math.abs(daysBetween(t.on, bank.postedOn)) }))
		.sort((a, b) => a.days - b.days)
		.slice(0, POOL);
	const found: Suggestion[] = [];
	const walk = (start: number, picked: typeof pool, sum: number) => {
		if (picked.length > 0 && sum === bank.amountCents) {
			found.push({
				parts: picked.map(({ t }) => ({
					target: t.ref,
					amountCents: remainingOf(t),
				})),
				days: Math.max(...picked.map((p) => p.days)),
				referenced: picked.some(({ t }) => mentions(bank.description, t)),
			});
			return;
		}
		if (picked.length === MAX_COMBINED) return;
		for (let i = start; i < pool.length; i++) {
			const next = sum + remainingOf(pool[i].t);
			if (Math.abs(next) > Math.abs(bank.amountCents)) continue;
			walk(i + 1, [...picked, pool[i]], next);
		}
	};
	walk(0, [], 0);
	const suggestions = found
		.sort(
			(a, b) =>
				Number(b.referenced) - Number(a.referenced) ||
				a.parts.length - b.parts.length ||
				a.days - b.days,
		)
		.slice(0, 5);
	const [first, second] = suggestions;
	const ambiguous =
		second !== undefined &&
		first.referenced === second.referenced &&
		first.parts.length === second.parts.length;
	return { suggestions, ambiguous };
}
