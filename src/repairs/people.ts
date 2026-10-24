import { and, asc, eq, isNull, sql } from "drizzle-orm";
import type { Db } from "#/db/client";
import { people, repairs } from "#/db/repair-schema";
import { RepairError } from "./draft-sync";
import { boardStatuses } from "./status";

// The shop's people, edited in Settings. A technician can be given a
// repair. Removing someone archives them, so the repairs they had keep
// their name, and taking their open repairs off them is left to staff.

export async function listPeople(db: Db) {
	return db
		.select({
			id: people.id,
			name: people.name,
			technician: people.technician,
			open: sql<number>`(select count(*)::int from ${repairs} where technician_id = ${people.id} and status in (${sql.join(
				boardStatuses.map((s) => sql`${s}`),
				sql`, `,
			)}))`,
		})
		.from(people)
		.where(isNull(people.archivedAt))
		.orderBy(asc(sql`lower(${people.name})`));
}
export type Person = Awaited<ReturnType<typeof listPeople>>[number];

function nameOf(raw: string) {
	const name = raw.trim().replace(/\s+/g, " ");
	if (name.length < 1 || name.length > 40)
		throw new RepairError("Names are 1 to 40 characters");
	return name;
}

// The only unique rule on people is the name.
const taken = (e: unknown) => {
	const err = e as { code?: string; cause?: { code?: string } };
	return err.code === "23505" || err.cause?.code === "23505";
};

export async function addPerson(db: Db, raw: string, technician: boolean) {
	const name = nameOf(raw);
	try {
		const [made] = await db
			.insert(people)
			.values({ name, technician })
			.returning({ id: people.id });
		return made.id;
	} catch (error) {
		if (taken(error)) throw new RepairError(`${name} is already there`);
		throw error;
	}
}

export async function editPerson(
	db: Db,
	id: number,
	edit: { name?: string; technician?: boolean },
) {
	const name = edit.name === undefined ? undefined : nameOf(edit.name);
	try {
		const done = await db
			.update(people)
			.set({
				...(name !== undefined && { name }),
				...(edit.technician !== undefined && { technician: edit.technician }),
			})
			.where(and(eq(people.id, id), isNull(people.archivedAt)))
			.returning({ id: people.id });
		if (done.length === 0) throw new RepairError("That person was removed");
	} catch (error) {
		if (taken(error)) throw new RepairError(`${name} is already there`);
		throw error;
	}
}

export async function removePerson(db: Db, id: number) {
	await db
		.update(people)
		.set({ archivedAt: sql`now()` })
		.where(and(eq(people.id, id), isNull(people.archivedAt)));
}

export async function restorePerson(db: Db, id: number) {
	try {
		await db.update(people).set({ archivedAt: null }).where(eq(people.id, id));
	} catch (error) {
		if (taken(error)) throw new RepairError("Someone else has that name now");
		throw error;
	}
}
