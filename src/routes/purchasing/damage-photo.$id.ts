import { createFileRoute } from "@tanstack/react-router";

// A photo of damage, as uploaded. Photos never change, so browsers keep them.
export const Route = createFileRoute("/purchasing/damage-photo/$id")({
	server: {
		handlers: {
			GET: async ({ params }) => {
				const [{ damagePhoto }, { getDb }] = await Promise.all([
					import("#/purchasing/damage"),
					import("#/db/client"),
				]);
				const id = Number(params.id);
				const photo =
					Number.isInteger(id) && id > 0
						? await damagePhoto(getDb(), id)
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
