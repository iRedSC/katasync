import { createFileRoute } from "@tanstack/react-router";

// Photos of a damage from a link Claude got from report_damage or
// damage_photo_link, for uploading from its shell. Public: the link is the
// key, and it expires.
export const Route = createFileRoute("/api/uploads/damage/$token")({
	server: {
		handlers: {
			// Without it the sign-in guard, which lets every method through here,
			// would hand a signed-out GET to the app's pages.
			GET: () =>
				new Response("Method Not Allowed", {
					status: 405,
					headers: { Allow: "POST" },
				}),
			POST: async ({ request, params }) => {
				const [{ damageForUploadLink, uploadResponse }, { getDb }] =
					await Promise.all([
						import("#/purchasing/damage"),
						import("#/db/client"),
					]);
				const db = getDb();
				const damageId = await damageForUploadLink(db, params.token);
				if (damageId === null)
					return Response.json(
						{ error: "This link is unknown or expired; ask for a new one" },
						{ status: 404 },
					);
				return uploadResponse(db, damageId, request);
			},
		},
	},
});
