import { createServerFn } from "@tanstack/react-start";
import { type } from "arktype";
import { getDb } from "#/db/client";
import {
	addDraftLine,
	addSetToOtherDrafts,
	draftFromSuggestions,
	lockDraftLine,
	openDraft,
	openSuggested,
	setDraftLine,
	skipSetPart,
	updateDraft,
	updateFromSuggestions,
} from "#/purchasing/orders";
import { discount } from "./discount-input";
import { id } from "./id-input";

// Starts a blank draft for a supplier, or opens the one they have.
export const createDraft = createServerFn({ method: "POST" })
	.validator(type({ supplierId: "number.integer > 0" }))
	.handler(async ({ data }) => openDraft(getDb(), data.supplierId));

// Makes the supplier's draft from today's suggestion.
export const createDraftFromSuggestions = createServerFn({ method: "POST" })
	.validator(type({ supplierId: "number.integer > 0" }))
	.handler(async ({ data }) => draftFromSuggestions(getDb(), data.supplierId));

// Opens a supplier's suggestion as a PO without making it a draft yet.
export const openSuggestedPurchaseOrder = createServerFn({ method: "POST" })
	.validator(type({ supplierId: "number.integer > 0" }))
	.handler(async ({ data }) => openSuggested(getDb(), data.supplierId));

// Brings a frozen draft up to date with what needs reordering today.
export const updateDraftFromSuggestions = createServerFn({ method: "POST" })
	.validator(id)
	.handler(async ({ data }) => updateFromSuggestions(getDb(), data.id));

// Puts a recommended addition on the draft at the quantity recommended. A
// product that got onto the draft meanwhile is left as it is.
export const addRecommended = createServerFn({ method: "POST" })
	.validator(
		type({
			purchaseOrderId: "number.integer > 0",
			productId: "number.integer > 0",
			quantity: "number.integer > 0",
		}),
	)
	.handler(async ({ data }) => addDraftLine(getDb(), data));

export const setLine = createServerFn({ method: "POST" })
	.validator(
		type({
			purchaseOrderId: "number.integer > 0",
			productId: "number.integer > 0",
			quantity: "number.integer >= 0",
			"unitCost?": "number >= 0 | null",
			"discounts?": discount.array(),
			"addedAt?": "Date",
		}),
	)
	.handler(async ({ data }) => setDraftLine(getDb(), data));

// Locks a draft line's quantity so Update leaves it alone, or unlocks it.
export const lockLine = createServerFn({ method: "POST" })
	.validator(
		type({
			purchaseOrderId: "number.integer > 0",
			productId: "number.integer > 0",
			locked: "boolean",
		}),
	)
	.handler(async ({ data }) => lockDraftLine(getDb(), data));

// Skips one part of a set on a draft, or orders it again.
export const skipPartOfSet = createServerFn({ method: "POST" })
	.validator(
		type({
			lineId: "number.integer > 0",
			productId: "number.integer > 0",
			skipped: "boolean",
		}),
	)
	.handler(async ({ data }) => skipSetPart(getDb(), data));

// Puts a set on the drafts of the other suppliers its parts are bought from.
export const addSetToOtherPos = createServerFn({ method: "POST" })
	.validator(type({ lineId: "number.integer > 0" }))
	.handler(async ({ data }) => addSetToOtherDrafts(getDb(), data));

export const editDraft = createServerFn({ method: "POST" })
	.validator(
		type({
			purchaseOrderId: "number.integer > 0",
			"notes?": "string | null",
			"locationId?": "number.integer > 0",
		}),
	)
	.handler(async ({ data }) => updateDraft(getDb(), data));
