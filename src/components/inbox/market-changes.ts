import type { MarketCursor, MarketMailPage } from "#/inbox/market-mail";
import { type Folder, flagsOf, type Level } from "#/inbox/rules";
import type { MarketView } from "./folders";

// What staff can do to a marketplace email, and where that leaves the lists.

export type Email = MarketMailPage["emails"][number];

// What happens to an email: done, back from done, to another folder, marked
// important, critical, or neither, or read or unread.
export type Change =
	| { done: boolean }
	| { to: Folder }
	| { level: Level }
	| { read: boolean };
// What undoes one: null hands the folder or importance back to the rules,
// when they had decided it.
export type Undo =
	| { done: boolean }
	| { to: Folder | null }
	| { level: Level | null }
	| { read: boolean };

export const after = (e: Email, change: Change): Email =>
	"done" in change
		? {
				...e,
				doneAt: change.done ? new Date() : null,
				voicemail:
					!change.done && e.voicemail?.state === "dismissed"
						? {
								state: "review",
								reason: `Restored: ${e.voicemail.reason}`.slice(0, 500),
							}
						: e.voicemail,
			}
		: "to" in change
			? { ...e, folder: change.to, why: { ...e.why, folder: "by-hand" } }
			: "level" in change
				? {
						...e,
						...flagsOf(change.level),
						why: { ...e.why, important: "by-hand" },
					}
				: { ...e, readAt: change.read ? new Date() : null };

// What undoing a change leaves: the fields that change made, as they were
// before it, and every later change (read since, moved since) kept.
export const putBack = (now: Email, before: Email, change: Change): Email =>
	"done" in change
		? { ...now, doneAt: before.doneAt, voicemail: before.voicemail }
		: "to" in change
			? {
					...now,
					folder: before.folder,
					why: { ...now.why, folder: before.why.folder },
				}
			: "level" in change
				? {
						...now,
						important: before.important,
						critical: before.critical,
						why: { ...now.why, important: before.why.important },
					}
				: { ...now, readAt: before.readAt };

// Where an email is listed.
export const belongs = (view: MarketView, e: Email) =>
	view === "done"
		? e.doneAt !== null
		: e.doneAt === null &&
			(view === "important"
				? e.important
				: view === "voicemails"
					? e.voicemail !== null
					: e.voicemail === null && e.folder === view);

// The pages past the first, from "Show more". A change reloads only the first
// page, so these keep every row as the server has it, and the list shows the
// ones that still belong. A row is changed in place, so putting it back puts it
// back where it was.
export type Extra = { emails: Email[]; next: MarketCursor | null };

export const withEmail = (
	extra: Extra | null,
	id: Email["id"],
	to: (e: Email) => Email,
): Extra | null =>
	extra?.emails.some((e) => e.id === id)
		? { ...extra, emails: extra.emails.map((e) => (e.id === id ? to(e) : e)) }
		: extra;

// The list shown: the first page, then the later pages' rows that still
// belong and aren't already in the first page, which is fresher.
export function listed(
	view: MarketView,
	page: MarketMailPage,
	extra: Extra | null,
): MarketMailPage {
	if (!extra) return page;
	const first = new Set(page.emails.map((e) => e.id));
	return {
		...page,
		emails: [
			...page.emails,
			...extra.emails.filter((e) => !first.has(e.id) && belongs(view, e)),
		],
		next: extra.next,
	};
}
