import { expect, test } from "vitest";
import type { MarketMailPage } from "#/inbox/market-mail";
import {
	after,
	type Email,
	type Extra,
	listed,
	withEmail,
} from "./market-changes";

const mail = (id: number, over: Partial<Email> = {}) =>
	({
		id,
		folder: "orders",
		doneAt: null,
		readAt: null,
		voicemail: null,
		important: false,
		critical: false,
		why: { folder: "rule", important: "rule" },
		...over,
	}) as unknown as Email;

const page = (emails: Email[]) =>
	({ emails, next: null, counts: {} }) as unknown as MarketMailPage;

test("a saved change to a loaded-more email stays after the first page reloads", () => {
	const extra: Extra = { emails: [mail(10), mail(11)], next: null };
	// Marked done: written into the stored extra pages.
	const kept = withEmail(extra, 10, (e) => after(e, { done: true }));
	// The reload brings page 1 only; the optimistic overlay is gone.
	const shown = listed("orders", page([mail(1)]), kept);
	expect(shown.emails.map((e) => e.id)).toEqual([1, 11]);
});

test("putting it back restores the row where it was", () => {
	const original = mail(10);
	const extra: Extra = { emails: [mail(9), original, mail(11)], next: null };
	const gone = withEmail(extra, 10, (e) => after(e, { done: true }));
	const back = withEmail(gone, 10, () => original);
	expect(listed("orders", page([]), back).emails.map((e) => e.id)).toEqual([
		9, 10, 11,
	]);
});

test("a row also on the fresh first page comes from the first page", () => {
	const extra: Extra = { emails: [mail(2, { readAt: null })], next: null };
	const fresh = mail(2, { readAt: new Date() });
	const shown = listed("orders", page([fresh]), extra);
	expect(shown.emails).toEqual([fresh]);
});

test("the cursor stays the later pages' own", () => {
	const next = { at: new Date(), id: 5 } as unknown as Extra["next"];
	const shown = listed("orders", page([mail(1)]), { emails: [], next });
	expect(shown.next).toBe(next);
});

test("an unknown id leaves the extra pages alone", () => {
	const extra: Extra = { emails: [mail(1)], next: null };
	expect(withEmail(extra, 99, (e) => e)).toBe(extra);
	expect(withEmail(null, 1, (e) => e)).toBeNull();
});
