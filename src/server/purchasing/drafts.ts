import { createServerFn } from "@tanstack/react-start";
import { type } from "arktype";
import { eq } from "drizzle-orm";
import { getDb } from "#/db/client";
import { purchaseOrders } from "#/db/schema";
import { DEMAND_DAYS } from "#/purchasing/forecast";
import {
	addDraftLine,
	addSetToOtherDrafts,
	applySettings,
	draftFromSuggestions,
	lockDraftLine,
	openDraft,
	openSuggested,
	previewSettings,
	refreshSuggested,
	restoreSettings,
	type SettingsUndo,
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

// Brings a frozen draft up to date with what needs reordering today, under
// its own suggestion settings: adds and raises, never lowers. A suggested PO
// just follows the suggestion again.
export const updateDraftFromSuggestions = createServerFn({ method: "POST" })
	.validator(id)
	.handler(async ({ data }) => {
		const db = getDb();
		const [po] = await db
			.select({ status: purchaseOrders.status })
			.from(purchaseOrders)
			.where(eq(purchaseOrders.id, data.id));
		if (po?.status === "suggested") {
			await refreshSuggested(db, data.id);
			return { added: 0, raised: 0 };
		}
		return updateFromSuggestions(db, data.id);
	});

const settings = type({
	coverDays: `1 <= number.integer <= ${DEMAND_DAYS} | null`,
	excludedCatalogs: "(number.integer > 0)[]",
	includePricier: "boolean",
});

// What new suggestion settings would do to a PO, changing nothing.
export const previewSuggestionSettings = createServerFn({ method: "GET" })
	.validator(type({ id: "number.integer > 0", settings }))
	.handler(async ({ data }) =>
		previewSettings(getDb(), data.id, data.settings),
	);

// Saves a PO's suggestion settings and makes its lines match them. Returns
// what it changed and what undo needs.
export const applySuggestionSettings = createServerFn({ method: "POST" })
	.validator(type({ id: "number.integer > 0", settings }))
	.handler(async ({ data }) => applySettings(getDb(), data.id, data.settings));

export const undoSuggestionSettings = createServerFn({ method: "POST" })
	.validator(type({ id: "number.integer > 0", undo: "object" }))
	.handler(async ({ data }) =>
		// Only ever what applySuggestionSettings handed back.
		restoreSettings(getDb(), data.id, data.undo as SettingsUndo),
	);

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
