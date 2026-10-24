import { createFileRoute } from "@tanstack/react-router";

// The 4x6 box label for a listed bench job's refurb
// (src/printing/refurb-label.tsx), printed as it's listed.
export const Route = createFileRoute("/labels/bench/$id")({
	server: {
		handlers: {
			GET: async ({ params }) => {
				const { getDb } = await import("#/db/client");
				const { benchLabel, renderRefurbLabel } = await import(
					"#/printing/refurb-label"
				);
				const id = Number(params.id);
				const label = Number.isInteger(id)
					? await benchLabel(getDb(), id)
					: null;
				if (!label)
					return new Response("No listed bench job with that number", {
						status: 404,
					});
				return new Response(new Uint8Array(await renderRefurbLabel(label)), {
					headers: {
						"Content-Type": "application/pdf",
						"Content-Disposition": `inline; filename*=UTF-8''${encodeURIComponent(`${label.sku}.pdf`)}`,
						"Cache-Control": "no-store",
					},
				});
			},
		},
	},
});
