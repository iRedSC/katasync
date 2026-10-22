import { createServerFn } from "@tanstack/react-start";
import { type } from "arktype";
import { getDb } from "#/db/client";
import { setPoFileRemoved } from "#/purchasing/files";

// Files are added by uploading to /api/po-file-uploads/<PO>; these take one
// off its PO and put it back.
export const setPoFileOff = createServerFn({ method: "POST" })
	.validator(type({ id: "number.integer > 0", removed: "boolean" }))
	.handler(async ({ data }) =>
		setPoFileRemoved(getDb(), data.id, data.removed),
	);
