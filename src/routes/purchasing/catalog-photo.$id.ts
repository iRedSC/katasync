import { createFileRoute } from "@tanstack/react-router";

// A catalog's photo, as uploaded. Photos never change (a new one gets a new
// id), so browsers keep them.
export const Route = createFileRoute("/purchasing/catalog-photo/$id")({
	server: {
		handlers: {
			GET: async ({ params }) => {
				const [{ catalogPhoto }, { getDb }] = await Promise.all([
					import("#/purchasing/catalogs"),
					import("#/db/client"),
				]);
				const id = Number(params.id);
				const photo =
					Number.isInteger(id) && id > 0
						? await catalogPhoto(getDb(), id)
						: null;
				if (!photo) return new Response("No such photo", { status: 404 });
				return new Response(new Uint8Array(photo.data), {
					headers: {
						"Content-Type": photo.contentType,
						"Cache-Control": "private, max-age=31536000, immutable",
					},
				});
			},
		},
	},
});
