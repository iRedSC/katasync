import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { type } from "arktype";
import { requireActor } from "#/audit/context";
import {
	addStaff,
	claimOwnership,
	removeStaff,
	restoreStaff,
	setRole,
	setupLinkForStaff,
} from "#/auth/staff";
import { getDb } from "#/db/client";

// Changing the staff list. Every one re-checks, inside its own transaction,
// that whoever asks is an owner right now (src/auth/authority.ts).

const linkUrl = (token: string) =>
	`${process.env.AUTH_ORIGIN ?? new URL(getRequest().url).origin}/setup?token=${token}`;

const role = "'owner' | 'operator'";

export const addStaffMember = createServerFn({ method: "POST" })
	.validator(type({ name: "string", role }))
	.handler(async ({ data }) => {
		const made = await addStaff(getDb(), requireActor(), data);
		return {
			staffId: made.staffId,
			url: linkUrl(made.token),
			expiresAt: made.expiresAt,
		};
	});

export const createDeviceLink = createServerFn({ method: "POST" })
	.validator(type({ staffId: "string.uuid" }))
	.handler(async ({ data }) => {
		const made = await setupLinkForStaff(getDb(), requireActor(), data.staffId);
		return { url: linkUrl(made.token), expiresAt: made.expiresAt };
	});

export const setStaffRole = createServerFn({ method: "POST" })
	.validator(type({ staffId: "string.uuid", role }))
	.handler(async ({ data }) =>
		setRole(getDb(), requireActor(), data.staffId, data.role),
	);

export const removeStaffMember = createServerFn({ method: "POST" })
	.validator(type({ staffId: "string.uuid" }))
	.handler(async ({ data }) =>
		removeStaff(getDb(), requireActor(), data.staffId),
	);

export const restoreStaffMember = createServerFn({ method: "POST" })
	.validator(type({ staffId: "string.uuid" }))
	.handler(async ({ data }) =>
		restoreStaff(getDb(), requireActor(), data.staffId),
	);

export const becomeOwner = createServerFn({ method: "POST" })
	.validator(type({ name: "string" }))
	.handler(async ({ data }) =>
		claimOwnership(getDb(), requireActor(), data.name),
	);
