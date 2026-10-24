import { createFileRoute } from "@tanstack/react-router";

// A file attached to a buyer reply from the Inbox, which has a session (the
// sign-in guard refuses this without one).
export const Route = createFileRoute("/api/buyer-file-uploads")({
	server: {
		handlers: {
			POST: async ({ request }) => {
				const [{ uploadResponse }, { getDb }] = await Promise.all([
					import("#/buyers/reply-files"),
					import("#/db/client"),
				]);
				return uploadResponse(getDb(), request);
			},
		},
	},
});
