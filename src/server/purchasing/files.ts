import { createServerFn } from "@tanstack/react-start";
import { type } from "arktype";
import { getDb } from "#/db/client";
import {
	movePoFiles,
	setPoFilesRemoved,
	unmovePoFiles,
} from "#/purchasing/files";
import { recentPos } from "#/purchasing/inbox/views";

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

// Moves one row of the Files card to another PO, and back for Undo.
export const movePoFilesTo = createServerFn({ method: "POST" })
	.validator(
		type({
			from: "number.integer > 0",
			to: "number.integer > 0",
			files: "(number.integer > 0)[]",
			attachments: "(number.integer > 0)[]",
		}),
	)
	.handler(async ({ data }) =>
		movePoFiles(getDb(), { ...data, movedBy: "staff" }),
	);

export const unmovePoFilesTo = createServerFn({ method: "POST" })
	.validator(
		type({
			added: "number.integer > 0 | null",
			files: "(number.integer > 0)[]",
			attachments: "(number.integer > 0)[]",
		}),
	)
	.handler(async ({ data }) => unmovePoFiles(getDb(), data));

// The POs a file can be moved to: those sent in the last half year.
export const posToMoveFilesTo = createServerFn({ method: "GET" }).handler(
	async () => (await recentPos(getDb())).map(({ supplierEmail: _, ...p }) => p),
);
