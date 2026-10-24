import { createFileRoute } from "@tanstack/react-router";

// A file attached to a buyer reply, from the app, which has a session (the
// sign-in guard refuses this without one).
export const Route = createFileRoute("/api/buyer-files/$fileId")({
	server: {
		handlers: {
			GET: async ({ params }) => {
				const [{ replyFile }, { getDb }, { fileResponse }] = await Promise.all([
					import("#/buyers/reply-files"),
					import("#/db/client"),
					import("#/lib/file-response"),
				]);
				const id = Number(params.fileId);
				if (!Number.isInteger(id) || id <= 0)
					return new Response("Not a file number", { status: 404 });
				const file = await replyFile(getDb(), id);
				if (!file) return new Response("No such file", { status: 404 });
				return fileResponse(file);
			},
		},
	},
});
