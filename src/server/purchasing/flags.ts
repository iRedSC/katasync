import { createServerFn } from "@tanstack/react-start";
import { type } from "arktype";
import { getDb } from "#/db/client";
import { reopenFlag, resolveFlag } from "#/purchasing/flags";
import { id } from "./id-input";

// Applies a PO flag (makes its change) or dismisses it.
export const resolvePoFlag = createServerFn({ method: "POST" })
	.validator(type({ id: "number.integer > 0", apply: "boolean" }))
	.handler(async ({ data }) => resolveFlag(getDb(), data));

// Puts a resolved flag back, setting back what applying it changed.
export const reopenPoFlag = createServerFn({ method: "POST" })
	.validator(id)
	.handler(async ({ data }) => reopenFlag(getDb(), data.id));
