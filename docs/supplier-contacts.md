# Supplier contacts

A supplier has any number of contacts. Every email we send a supplier (POs and
damage reports) goes to all of them at once, in one message, so they can
reply-all and see who else got it.

## Data

New table, replacing `suppliers.email` and `suppliers.contactName`:

```ts
export const supplierContacts = pgTable(
	"supplier_contacts",
	{
		id: integer().primaryKey().generatedAlwaysAsIdentity(),
		supplierId: integer()
			.notNull()
			.references(() => suppliers.id, { onDelete: "cascade" }),
		// Optional: "Hi Ann," when set.
		name: text(),
		email: text().notNull(),
		// Form order; the first is who the greeting and PDF name first.
		position: integer().notNull(),
	},
	(t) => [
		uniqueIndex("supplier_contacts_email").on(t.supplierId, sql`lower(${t.email})`),
		index("supplier_contacts_supplier_idx").on(t.supplierId),
		check("supplier_contacts_email_shape", sql`${t.email} ~ '^[^@\\s]+@[^@\\s]+$'`),
	],
);
```

Snapshots become lists, so a sent PO still shows who it went to after contacts
change:

- `purchase_orders.sent_to`: `text` to `text[]`, with
  `check (sent_to is null or cardinality(sent_to) > 0)`.
- `purchase_order_damage_reports.sent_to`: `text not null` to `text[] not null`,
  with `check (cardinality(sent_to) > 0)`.

### Invalid states and what prevents them

| State | Prevented by |
| --- | --- |
| Same address twice on a supplier | unique index on `(supplier_id, lower(email))` |
| A contact with no email | `email not null`; a name-only person has nowhere to send |
| Malformed address | arktype `string.email` at the server fn, DB check as backstop |
| Sending to nobody | `recipients(supplier)` returns `NonEmpty<string>` or `null`; `sendEmail` takes `NonEmpty<string>` |
| A sent PO with an empty recipient list | `cardinality(sent_to) > 0` |
| Over Resend's 50-recipient limit (To plus the Bcc copy) | `contactProblems` flags the 50th contact; 49 at most |

## Migration

One migration, in a transaction:

1. Create `supplier_contacts`.
2. For each supplier with an `email`: split it on `,` and `;` (Sumtracker
   imports sometimes hold several), trim, dedupe case-insensitively, insert one
   contact per address. The first gets `contact_name` as its name.
3. A supplier with a `contact_name` but no `email` keeps the name by appending
   `Contact: <name>` to `notes`. Nothing is dropped silently.
4. `sent_to` columns: `array[sent_to]` for existing values.
5. Drop `suppliers.email` and `suppliers.contact_name`.
6. Grant `katasync_mcp` read on `supplier_contacts`.

`src/purchasing/contacts.test.ts` runs this migration over each of those
shapes.

## Sending

- `src/purchasing/email.ts` `sendEmail`: `to: NonEmpty<string>`, passed straight
  through as Resend's `to` array. Bcc to `PO_EMAIL_REPLY_TO` unchanged.
- `src/purchasing/contacts.ts` (new): `recipients(contacts)` and
  `greetingFor(contacts)`. The greeting names named contacts: one gives
  "Hi Ann,", two give "Hi Ann and Bob,", none or three-plus give "Hello,".
- `src/server/purchasing/lifecycle.ts` and `damage-reports.ts`: load contacts
  inside the locked send, so the recipients saved as `sent_to` are exactly who
  got it. Error when there are none stays "Add one in Suppliers".
- Preview returns `to: string[]`.

## UI

- **Supplier form** (`src/components/supplier-form.tsx`): "Contact person" and
  "Email POs to" become a **Contacts** list. Each row: name, email, remove (x).
  A blank row is always at the bottom; typing in it adds the next. Removing a
  row is undone by not saving, so no confirm. A bad row turns red with a short
  reason ("Already listed", "Needs an email") once its email is left, and
  saving shakes the first bad row.
- **Composer** (`src/components/email-composer.tsx`): To shows one chip per
  address. Read-only; who gets POs is a supplier setting, not a per-send choice.
- **PO page** (`src/routes/purchasing/$id.tsx`): `AddEmail` stays as the
  zero-contacts state and adds the first contact. Tooltip on Send lists all
  addresses.
- **Success toast, timeline, dates**: "Emailed to Ann, bob@acme.com" (names
  where known, else addresses); the dates card shows every address on hover.
- **Supplier page and PO list**: `mailto:` with every address, comma-joined.
- **PO PDF** (`src/purchasing/document.tsx`): the first contact's name and
  email under the supplier, as today. One line keeps the header stable.

## Inbox matching

`likelihood` in `src/purchasing/inbox/views.ts` takes `supplierEmails:
string[]` and matches on any of their domains. `recentPos` aggregates them with
`array_agg`. Tests in `views.test.ts` get a two-domain case (supplier staff on
a personal or parent-company domain).

## Everything else that reads the old fields

- `src/server/purchasing/suppliers.ts`: `updateSupplier` takes
  `contacts: { name: string | null; email: string }[]` and replaces the set in
  the same transaction as the supplier. `setSupplierEmail` becomes
  `addSupplierContact`.
- `src/mcp/server/supplier-tools.ts`, `po-for-claude.ts`: `contacts` array in
  and out.
- `src/import/sumtracker-suppliers.ts`: same split rule as the migration; the
  "no email" warning checks for zero contacts.
- `src/purchasing/load.ts`: `po.supplier.contacts` replaces `email` and
  `contactName`.

## Out of scope

- Per-contact roles (only POs, only damage reports). Add a role column later
  if a supplier needs it; the default "everyone gets everything" covers the ask.
- CC versus To. All in To.
- Per-send editing of recipients.
