import { createFileRoute } from "@tanstack/react-router";

// A file attached to a buyer reply, at the public address a marketplace
// (eBay) fetches it from. Public (src/auth/guard.ts): the token is the key.
export const Route = createFileRoute("/api/shared-files/$token")({
	server: {
		handlers: {
			GET: async ({ params }) => {
				const [{ sharedFile }, { getDb }, { fileResponse }] = await Promise.all(
					[
						import("#/buyers/reply-files"),
						import("#/db/client"),
						import("#/lib/file-response"),
					],
				);
				const file = await sharedFile(getDb(), params.token);
				if (!file) return new Response("No such file", { status: 404 });
				return fileResponse(file);
			},
		},
	},
});
