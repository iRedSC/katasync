import { createServerFn } from "@tanstack/react-start";
import { type } from "arktype";
import { getDb } from "#/db/client";
import { setPoFilesRemoved } from "#/purchasing/files";

// Files are added by uploading to /api/po-file-uploads/<PO>; this takes some
// off their PO and puts them back: its own, and its emails'.
export const setPoFilesOff = createServerFn({ method: "POST" })
	.validator(
		type({
			files: "(number.integer > 0)[]",
			attachments: "(number.integer > 0)[]",
			removed: "boolean",
		}),
	)
	.handler(async ({ data }) =>
		setPoFilesRemoved(
			getDb(),
			{ files: data.files, attachments: data.attachments },
			data.removed,
		),
	);
