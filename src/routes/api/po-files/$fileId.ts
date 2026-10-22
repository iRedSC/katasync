import { createFileRoute } from "@tanstack/react-router";

// A file put on a PO, from the app, which has a session (the sign-in guard
// refuses this without one).
export const Route = createFileRoute("/api/po-files/$fileId")({
	server: {
		handlers: {
			GET: async ({ params }) => {
				const [{ poFile }, { getDb }, { fileResponse }] = await Promise.all([
					import("#/purchasing/files"),
					import("#/db/client"),
					import("#/lib/file-response"),
				]);
				const id = Number(params.fileId);
				if (!Number.isInteger(id) || id <= 0)
					return new Response("Not a file number", { status: 404 });
				const file = await poFile(getDb(), id);
				if (!file) return new Response("No such file", { status: 404 });
				return fileResponse(file);
			},
		},
	},
});
