import { createFileRoute } from "@tanstack/react-router";

// A file a supplier emailed, from the app, which has a session (the sign-in
// guard refuses this without one).
export const Route = createFileRoute("/api/po-email-attachments/$attachmentId")(
	{
		server: {
			handlers: {
				GET: async ({ params }) => {
					const [{ attachmentFile }, { getDb }, { fileResponse }] =
						await Promise.all([
							import("#/purchasing/inbox/ingest"),
							import("#/db/client"),
							import("#/lib/file-response"),
						]);
					const id = Number(params.attachmentId);
					if (!Number.isInteger(id) || id <= 0)
						return new Response("Not an attachment number", { status: 404 });
					const file = await attachmentFile(getDb(), id);
					if (!file) return new Response("No such attachment", { status: 404 });
					if (!file.data)
						return new Response("Too large to keep; open it in Outlook", {
							status: 404,
						});
					return fileResponse({ ...file, data: file.data });
				},
			},
		},
	},
);
