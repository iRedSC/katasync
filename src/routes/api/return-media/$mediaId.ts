import { createFileRoute } from "@tanstack/react-router";

// A photo a buyer attached to a return (or a video's cover), as kept from
// the marketplace, from the app, which has a session (the sign-in guard
// refuses this without one).
export const Route = createFileRoute("/api/return-media/$mediaId")({
	server: {
		handlers: {
			GET: async ({ params, request }) => {
				const [{ recordPicture }, { getDb }, { fileResponse }] =
					await Promise.all([
						import("#/orders/return-records"),
						import("#/db/client"),
						import("#/lib/file-response"),
					]);
				const id = Number(params.mediaId);
				if (!Number.isInteger(id) || id <= 0)
					return new Response("Not a picture number", { status: 404 });
				const file = await recordPicture(getDb(), id);
				if (!file) return new Response("Not kept", { status: 404 });
				return fileResponse(file, request.headers.get("range"));
			},
		},
	},
});
