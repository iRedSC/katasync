import { createFileRoute } from "@tanstack/react-router";

// Photos of a damage from the app, which has a session (the sign-in guard
// refuses this without one).
export const Route = createFileRoute("/api/damage-photos/$damageId")({
	server: {
		handlers: {
			POST: async ({ request, params }) => {
				const [{ uploadResponse }, { getDb }] = await Promise.all([
					import("#/purchasing/damage"),
					import("#/db/client"),
				]);
				const damageId = Number(params.damageId);
				if (!Number.isInteger(damageId) || damageId <= 0)
					return new Response("Not a damage number", { status: 404 });
				return uploadResponse(getDb(), damageId, request);
			},
		},
	},
});
