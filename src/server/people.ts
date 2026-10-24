import { createServerFn } from "@tanstack/react-start";
import { type } from "arktype";
import { getDb } from "#/db/client";
import {
	addPerson,
	editPerson,
	listPeople,
	removePerson,
	restorePerson,
} from "#/repairs/people";

// The People card in Settings (src/repairs/people.ts).

const id = type({ id: "number.integer > 0" });

export const getPeople = createServerFn({ method: "GET" }).handler(() =>
	listPeople(getDb()),
);

export const addPersonNow = createServerFn({ method: "POST" })
	.validator(type({ name: "string", technician: "boolean" }))
	.handler(async ({ data }) => ({
		id: await addPerson(getDb(), data.name, data.technician),
	}));

export const editPersonNow = createServerFn({ method: "POST" })
	.validator(
		type({
			id: "number.integer > 0",
			"name?": "string",
			"technician?": "boolean",
		}),
	)
	.handler(async ({ data: { id: personId, ...edit } }) =>
		editPerson(getDb(), personId, edit),
	);

export const removePersonNow = createServerFn({ method: "POST" })
	.validator(id)
	.handler(async ({ data }) => removePerson(getDb(), data.id));

export const restorePersonNow = createServerFn({ method: "POST" })
	.validator(id)
	.handler(async ({ data }) => restorePerson(getDb(), data.id));
