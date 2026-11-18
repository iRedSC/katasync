import { sql } from "drizzle-orm";

// Who a supplier's emails go to (supplierContacts). Every PO and damage
// report goes to all of them in one message, so they can reply-all.

export type SupplierContact = { name: string | null; email: string };

// At least one address. sendEmail only takes this, so nothing is ever sent to
// nobody; recipientsOf is the only way to get one from contacts.
export type Recipients = readonly [string, ...string[]];

// Resend takes at most 50 addresses across To, Cc and Bcc, and every email
// also Bccs PO_EMAIL_REPLY_TO (src/purchasing/email.ts).
export const MAX_CONTACTS = 49;

const EMAIL = /^[^@\s]+@[^@\s]+$/;

export class ContactError extends Error {
	name = "ContactError";
}

export function recipientsOf(contacts: readonly SupplierContact[]) {
	const [first, ...rest] = contacts.map((c) => c.email);
	return first === undefined ? null : ([first, ...rest] as Recipients);
}

type Typed = { name: string | null; email: string };

// What's wrong with each contact as typed, by row, or null. Fully blank rows
// are fine; cleanContacts drops them.
export function contactProblems(rows: readonly Typed[]): (string | null)[] {
	const seen = new Set<string>();
	return rows.map((c) => {
		const email = c.email.trim();
		if (email === "") return c.name?.trim() ? "Needs an email" : null;
		if (!EMAIL.test(email)) return "Not an email address";
		const key = email.toLowerCase();
		if (seen.has(key)) return "Already listed";
		if (seen.size === MAX_CONTACTS)
			return `One email reaches ${MAX_CONTACTS} at most`;
		seen.add(key);
		return null;
	});
}

// Contacts as typed into the supplier form, ready to save: trimmed, fully
// blank rows dropped. Refuses any contactProblems.
export function cleanContacts(rows: readonly Typed[]): SupplierContact[] {
	const problems = contactProblems(rows);
	const at = problems.findIndex((p) => p !== null);
	if (at >= 0) {
		const row = rows[at];
		throw new ContactError(
			`${row.email.trim() || row.name?.trim()}: ${problems[at]}`,
		);
	}
	return rows.flatMap((c) => {
		const email = c.email.trim();
		return email ? [{ name: c.name?.trim() || null, email }] : [];
	});
}

// Splits an address list as other tools write it, "a@x.com; b@x.com".
export const splitAddresses = (text: string) =>
	text.split(/[,;]/).map((e) => ({ name: null, email: e }));

// "Hi Ann," "Hi Ann and Bob," and "Hello," for none, or for three or more,
// where a list of names reads worse than a plain hello.
export function greetingFor(contacts: readonly SupplierContact[]) {
	const names = contacts.flatMap((c) => (c.name ? [c.name] : []));
	if (names.length === 1) return `Hi ${names[0]},`;
	if (names.length === 2) return `Hi ${names[0]} and ${names[1]},`;
	return "Hello,";
}

// Who an email went to, short: names where known, else addresses.
export const recipientLabel = (
	sentTo: readonly string[],
	contacts: readonly SupplierContact[] = [],
) =>
	sentTo
		.map(
			(e) =>
				contacts.find((c) => c.email.toLowerCase() === e.toLowerCase())?.name ??
				e,
		)
		.join(", ");

// A supplier's contact addresses in order, as a column of a select joining
// suppliers.
export const contactEmailsColumn = sql<string[]>`coalesce((
	select array_agg(c.email order by c.position)
	from supplier_contacts c where c.supplier_id = "suppliers"."id"
), '{}'::text[])`;

// Whether an address shares a domain with any of a supplier's contacts.
export function fromSupplier(
	address: string,
	supplierEmails: readonly string[],
) {
	const domain = (a: string) => a.trim().toLowerCase().split("@")[1] ?? null;
	const d = domain(address);
	return d !== null && supplierEmails.some((e) => domain(e) === d);
}

// A supplier's contacts in order, as a column of a select on suppliers.
// Written out in full: in a one-table select Drizzle leaves column names
// unqualified, so the subquery's supplier_id would compare against itself.
export const contactsColumn = sql<SupplierContact[]>`coalesce((
	select jsonb_agg(jsonb_build_object('name', c.name, 'email', c.email) order by c.position)
	from supplier_contacts c where c.supplier_id = "suppliers"."id"
), '[]'::jsonb)`;
