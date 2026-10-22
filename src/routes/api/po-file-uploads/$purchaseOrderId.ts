import { createFileRoute } from "@tanstack/react-router";

// Files put on a PO from its page, which has a session (the sign-in guard
// refuses this without one).
export const Route = createFileRoute("/api/po-file-uploads/$purchaseOrderId")({
	server: {
		handlers: {
			POST: async ({ request, params }) => {
				const [{ fileUploadResponse }, { getDb }] = await Promise.all([
					import("#/purchasing/files"),
					import("#/db/client"),
				]);
				const id = Number(params.purchaseOrderId);
				if (!Number.isInteger(id) || id <= 0)
					return new Response("Not a PO number", { status: 404 });
				return fileUploadResponse(getDb(), id, request, "staff");
			},
		},
	},
});
