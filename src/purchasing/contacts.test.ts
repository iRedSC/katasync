import { PGlite } from "@electric-sql/pglite";
import { readMigrationFiles } from "drizzle-orm/migrator";
import { describe, expect, test } from "vitest";
import {
	cleanContacts,
	contactProblems,
	fromSupplier,
	greetingFor,
	recipientLabel,
	recipientsOf,
} from "./contacts";

const c = (email: string, name: string | null = null) => ({ name, email });

describe("cleanContacts", () => {
	test("trims, and drops fully blank rows", () => {
		expect(
			cleanContacts([
				c(" ann@acme.com ", " Ann "),
				c(" ", " "),
				c("b@acme.com"),
			]),
		).toEqual([c("ann@acme.com", "Ann"), c("b@acme.com")]);
	});

	test("says what's wrong with each row", () => {
		expect(
			contactProblems([
				c("ann@acme.com"),
				c("ANN@acme.com"),
				c("", "Bob"),
				c("nope"),
				c(""),
			]),
		).toEqual([
			null,
			"Already listed",
			"Needs an email",
			"Not an email address",
			null,
		]);
		expect(() => cleanContacts([c("a@x.com"), c("A@X.COM")])).toThrow(
			"Already listed",
		);
	});

	test("refuses more than one email can go to", () => {
		const many = Array.from({ length: 50 }, (_, i) => c(`p${i}@acme.com`));
		expect(contactProblems(many).at(-1)).toBe("One email reaches 49 at most");
		expect(() => cleanContacts(many)).toThrow("49 at most");
		expect(cleanContacts(many.slice(0, 49))).toHaveLength(49);
	});
});

test("recipientsOf has no list for no contacts", () => {
	expect(recipientsOf([])).toBeNull();
	expect(recipientsOf([c("a@x.com"), c("b@x.com")])).toEqual([
		"a@x.com",
		"b@x.com",
	]);
});

test("greetingFor names up to two people", () => {
	expect(greetingFor([c("a@x.com", "Ann")])).toBe("Hi Ann,");
	expect(
		greetingFor([c("a@x.com", "Ann"), c("o@x.com"), c("b@x.com", "Bob")]),
	).toBe("Hi Ann and Bob,");
	expect(greetingFor([c("o@x.com")])).toBe("Hello,");
	expect(
		greetingFor([c("a@x.com", "A"), c("b@x.com", "B"), c("d@x.com", "D")]),
	).toBe("Hello,");
});

test("recipientLabel names who it can", () => {
	expect(
		recipientLabel(["ANN@x.com", "ap@x.com"], [c("ann@x.com", "Ann")]),
	).toBe("Ann, ap@x.com");
});

test("fromSupplier matches any contact's domain", () => {
	expect(fromSupplier("Sales@Acme.com", ["rep@gmail.com", "ap@acme.com"])).toBe(
		true,
	);
	expect(fromSupplier("sales@acme.com", [])).toBe(false);
});

test("the contacts migration keeps every address and name", async () => {
	const client = new PGlite();
	try {
		const migrations = readMigrationFiles({ migrationsFolder: "drizzle" });
		const at = migrations.findIndex((m) =>
			m.sql.some((s) => s.includes('CREATE TABLE "supplier_contacts"')),
		);
		if (at < 0) throw new Error("Contacts migration not found");
		for (const m of migrations.slice(0, at))
			for (const s of m.sql) await client.exec(s);
		await client.exec(`
			insert into suppliers (id, code, name, contact_name, email, notes) overriding system value values
				(1, 'ONE', 'One', 'Ann', 'ann@one.com', null),
				(2, 'MANY', 'Many', 'Bob', 'bob@many.com; AP@many.com,bob@MANY.com ,', null),
				(3, 'NAME', 'Name only', 'Cy', null, 'Free freight'),
				(4, 'BAD', 'Bad', null, 'call them, ok@bad.com', null),
				(5, 'NONE', 'None', null, null, null);
			insert into locations (id, name, kind) overriding system value values (1, 'Shop', 'owned');
			insert into purchase_orders (supplier_id, location_id, status, sent_at, sent_to) values
				(1, 1, 'sent', now(), 'ann@one.com'),
				(2, 1, 'sent', now(), null);
		`);
		for (const m of migrations.slice(at))
			for (const s of m.sql) await client.exec(s);

		const { rows: contacts } = await client.query(
			"select supplier_id, name, email, position from supplier_contacts order by supplier_id, position",
		);
		expect(contacts).toEqual([
			{ supplier_id: 1, name: "Ann", email: "ann@one.com", position: 0 },
			{ supplier_id: 2, name: "Bob", email: "bob@many.com", position: 0 },
			{ supplier_id: 2, name: null, email: "AP@many.com", position: 1 },
			{ supplier_id: 4, name: null, email: "ok@bad.com", position: 0 },
		]);
		const { rows: notes } = await client.query(
			"select id, notes from suppliers where notes is not null order by id",
		);
		expect(notes).toEqual([
			{ id: 3, notes: "Free freight\nContact: Cy" },
			{ id: 4, notes: "Email: call them, ok@bad.com" },
		]);
		const { rows: sent } = await client.query(
			"select sent_to from purchase_orders order by supplier_id",
		);
		expect(sent).toEqual([{ sent_to: ["ann@one.com"] }, { sent_to: null }]);
	} finally {
		await client.close();
	}
	// Runs every migration on a fresh database.
}, 60_000);
