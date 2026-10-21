import { createServerFn } from "@tanstack/react-start";
import { type } from "arktype";
import { getDb } from "#/db/client";
import { fileEmail, setAside } from "#/purchasing/inbox/ingest";
import { addTracking, removeTracking } from "#/purchasing/tracking";
import { id } from "./id-input";

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

export const addPoTracking = createServerFn({ method: "POST" })
	.validator(
		type({
			purchaseOrderId: "number.integer > 0",
			number: "string > 0",
			"carrier?": "'ups' | 'usps' | 'fedex'",
		}),
	)
	.handler(async ({ data }) => addTracking(getDb(), data));

export const removePoTracking = createServerFn({ method: "POST" })
	.validator(id)
	.handler(async ({ data }) => removeTracking(getDb(), data.id));
