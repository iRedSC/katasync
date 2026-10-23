import { createFileRoute } from "@tanstack/react-router";

// A catalog photo from the app (the sign-in guard refuses this without a
// session). Answers with its id, which setCatalogPhoto then shows.
export const Route = createFileRoute("/api/catalog-photos/")({
	server: {
		handlers: {
			POST: async ({ request }) => {
				const [{ addCatalogPhoto }, { PurchaseOrderError }, { getDb }] =
					await Promise.all([
						import("#/purchasing/catalogs"),
						import("#/purchasing/orders"),
						import("#/db/client"),
					]);
				const bytes = new Uint8Array(await request.arrayBuffer());
				if (bytes.length === 0)
					return Response.json(
						{ error: "No photo in the upload" },
						{ status: 400 },
					);
				try {
					return Response.json({
						photoId: await addCatalogPhoto(getDb(), bytes),
					});
				} catch (err) {
					if (!(err instanceof PurchaseOrderError)) throw err;
					return Response.json({ error: err.message }, { status: 422 });
				}
			},
		},
	},
});
