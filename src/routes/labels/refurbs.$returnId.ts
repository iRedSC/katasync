import { createFileRoute } from "@tanstack/react-router";

// The 4x6 box label for a refurbished receipt (src/printing/refurb-label.tsx),
// printed as it's made and from the Received list.
export const Route = createFileRoute("/labels/refurbs/$returnId")({
	server: {
		handlers: {
			GET: async ({ params }) => {
				const { getDb } = await import("#/db/client");
				const { refurbLabel, renderRefurbLabel } = await import(
					"#/printing/refurb-label"
				);
				const id = Number(params.returnId);
				const label = Number.isInteger(id)
					? await refurbLabel(getDb(), id)
					: null;
				if (!label)
					return new Response("No refurbished return with that id", {
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
