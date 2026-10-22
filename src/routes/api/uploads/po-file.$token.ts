import { createFileRoute } from "@tanstack/react-router";

// Files for a PO from a link Claude got from po_file_upload_link, for
// uploading from its shell. Public: the link is the key, and it expires.
export const Route = createFileRoute("/api/uploads/po-file/$token")({
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
				const [{ poForUploadLink, fileUploadResponse }, { getDb }] =
					await Promise.all([
						import("#/purchasing/files"),
						import("#/db/client"),
					]);
				const db = getDb();
				const purchaseOrderId = await poForUploadLink(db, params.token);
				if (purchaseOrderId === null)
					return Response.json(
						{ error: "This link is unknown or expired; ask for a new one" },
						{ status: 404 },
					);
				return fileUploadResponse(db, purchaseOrderId, request, "claude");
			},
		},
	},
});
