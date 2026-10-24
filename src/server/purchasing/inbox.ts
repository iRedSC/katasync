import { createServerFn } from "@tanstack/react-start";
import { type } from "arktype";
import { getDb } from "#/db/client";
import {
	takeSuggestion,
	undoFiling,
	undoSetAside,
} from "#/purchasing/inbox/ai-filing";
import {
	countUnfiled,
	fileEmail,
	setAside,
	setRead,
} from "#/purchasing/inbox/ingest";
import { emailsToLink, inboxPage } from "#/purchasing/inbox/views";
import {
	addTracking,
	fillHistory,
	removeTracking,
} from "#/purchasing/tracking";
import { id } from "./id-input";

// One list of the supplier-email inbox page.
export const listPoEmails = createServerFn({ method: "GET" })
	.validator(type({ view: "'unfiled' | 'filed'" }))
	.handler(async ({ data }) => inboxPage(getDb(), data.view));

// Unfiled emails, the ones likeliest about this PO first.
export const emailsToLinkTo = createServerFn({ method: "GET" })
	.validator(id)
	.handler(async ({ data }) => emailsToLink(getDb(), data.id));

// Unread emails waiting to be filed, for the sidebar.
export const countEmailsToFile = createServerFn({ method: "GET" }).handler(
	async () => (await countUnfiled(getDb())).toFileUnread,
);

export const setPoEmailRead = createServerFn({ method: "POST" })
	.validator(type({ id: "number.integer > 0", read: "boolean" }))
	.handler(async ({ data }) => setRead(getDb(), data.id, data.read));

export const filePoEmail = createServerFn({ method: "POST" })
	.validator(
		type({
			emailId: "number.integer > 0",
			purchaseOrderId: "number.integer > 0 | null",
		}),
	)
	.handler(async ({ data }) => fileEmail(getDb(), { ...data, by: "staff" }));

export const setAsidePoEmail = createServerFn({ method: "POST" })
	.validator(type({ id: "number.integer > 0", aside: "boolean" }))
	.handler(async ({ data }) => setAside(getDb(), data.id, data.aside));

// Files an email on the PO the AI suggested, with the changes it read.
export const takeAiSuggestion = createServerFn({ method: "POST" })
	.validator(id)
	.handler(async ({ data }) => takeSuggestion(getDb(), data.id));

// Sets back what the AI's filing of an email changed.
export const undoAiFiling = createServerFn({ method: "POST" })
	.validator(id)
	.handler(async ({ data }) => undoFiling(getDb(), data.id));

// Brings back an email the AI set aside as a copy.
export const undoAiSetAside = createServerFn({ method: "POST" })
	.validator(id)
	.handler(async ({ data }) => undoSetAside(getDb(), data.id));

export const addPoTracking = createServerFn({ method: "POST" })
	.validator(
		type({
			purchaseOrderId: "number.integer > 0",
			number: "string > 0",
			"carrier?": "'ups' | 'usps' | 'fedex'",
		}),
	)
	.handler(async ({ data }) => addTracking(getDb(), data));

export const fillPoTrackingHistory = createServerFn({ method: "POST" })
	.validator(type({ purchaseOrderId: "number.integer > 0" }))
	.handler(async ({ data }) => fillHistory(getDb(), data.purchaseOrderId));

export const removePoTracking = createServerFn({ method: "POST" })
	.validator(id)
	.handler(async ({ data }) => removeTracking(getDb(), data.id));
