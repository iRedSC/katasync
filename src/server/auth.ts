import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { type } from "arktype";
import { and, eq } from "drizzle-orm";
import { requireActor } from "#/audit/context";
import { type Actor, mayAdminister } from "#/auth/actor";
import {
	assignDevice as assign,
	listDevices as devices,
	removeDevice as remove,
	renameDevice as rename,
} from "#/auth/devices";
import {
	answerAuthorize,
	checkAuthorize,
	disconnect,
	endpoints,
	listConnections as oauthConnections,
	originOf,
} from "#/auth/oauth";
import { listStaff } from "#/auth/staff";
import { getDb } from "#/db/client";
import { staff } from "#/db/identity-schema";

// Who's signed in, the staff list, and the devices that can sign in, for
// Settings. Owners see and change everything; anyone else sees themselves.

const whoIs = (actor: Actor) => {
	switch (actor.kind) {
		case "staff":
			return {
				kind: "staff" as const,
				staffId: actor.staffId,
				name: actor.name,
				role: actor.role,
			};
		case "legacy":
			return { kind: "unassigned" as const, name: actor.via.name };
		case "system":
			return { kind: "system" as const, name: actor.name };
	}
};

export const listDevices = createServerFn({ method: "GET" }).handler(
	async () => {
		const db = getDb();
		const actor = requireActor();
		const owner = mayAdminister(actor);
		const currentPasskey =
			actor.kind !== "system" && actor.via.kind === "device"
				? actor.via.passkeyId
				: null;
		const [allDevices, people, [anyOwner]] = await Promise.all([
			devices(db),
			owner ? listStaff(db) : Promise.resolve([]),
			db
				.select({ id: staff.id })
				.from(staff)
				.where(and(eq(staff.role, "owner"), eq(staff.status, "active")))
				.limit(1),
		]);
		const mine = (d: (typeof allDevices)[number]) =>
			d.id === currentPasskey ||
			(actor.kind === "staff" && d.staffId === actor.staffId);
		return {
			me: whoIs(actor),
			owner,
			needsOwner: actor.kind === "legacy" && !anyOwner,
			staff: people,
			devices: allDevices
				.filter((d) => owner || mine(d))
				.map((d) => ({ ...d, current: d.id === currentPasskey })),
		};
	},
);

export const renameDevice = createServerFn({ method: "POST" })
	.validator(type({ id: "string > 0", name: "string" }))
	.handler(async ({ data }) =>
		rename(getDb(), requireActor(), data.id, data.name),
	);

export const removeDevice = createServerFn({ method: "POST" })
	.validator(type({ id: "string > 0" }))
	.handler(async ({ data }) => remove(getDb(), requireActor(), data.id));

export const assignDevice = createServerFn({ method: "POST" })
	.validator(type({ id: "string > 0", staffId: "string.uuid" }))
	.handler(async ({ data }) =>
		assign(getDb(), requireActor(), data.id, data.staffId),
	);

export const listConnections = createServerFn({ method: "GET" }).handler(
	async () => ({
		endpoint: endpoints(originOf(getRequest())).resource,
		apps: await oauthConnections(getDb()),
	}),
);

export const disconnectApp = createServerFn({ method: "POST" })
	.validator(type({ id: "string.uuid" }))
	.handler(async ({ data }) => disconnect(getDb(), requireActor(), data.id));

const authorizeParams = type({
	"response_type?": "string",
	"client_id?": "string",
	"redirect_uri?": "string",
	"code_challenge?": "string",
	"code_challenge_method?": "string",
	"state?": "string",
	"resource?": "string",
});

export const checkAuthorization = createServerFn({ method: "GET" })
	.validator(authorizeParams)
	.handler(async ({ data }) =>
		checkAuthorize(getDb(), requireActor(), data, originOf(getRequest())),
	);

export const answerAuthorization = createServerFn({ method: "POST" })
	.validator(
		type({
			params: authorizeParams,
			answer: type({ approve: "true", canWrite: "boolean" }).or({
				approve: "false",
			}),
		}),
	)
	.handler(async ({ data }) =>
		answerAuthorize(
			getDb(),
			requireActor(),
			data.params,
			originOf(getRequest()),
			data.answer,
		),
	);
