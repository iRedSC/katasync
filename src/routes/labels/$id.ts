import { createFileRoute } from "@tanstack/react-router";

// A label's PDF, for printing or reprinting. Served from katasync's saved
// copy, fetched from the provider the first time if it wasn't saved yet.
export const Route = createFileRoute("/labels/$id")({
	server: {
		handlers: {
			GET: async ({ params }) => {
				const [{ labelPdf }, { getDb }] = await Promise.all([
					import("#/shipping/label-file"),
					import("#/db/client"),
				]);
				const id = Number(params.id);
				if (!Number.isInteger(id) || id <= 0)
					return new Response("Not a label number", { status: 404 });
				try {
					const pdf = await labelPdf(getDb(), id);
					return new Response(new Uint8Array(pdf), {
						headers: {
							"Content-Type": "application/pdf",
							"Content-Disposition": `inline; filename="label-${id}.pdf"`,
						},
					});
				} catch (err) {
					const why = err instanceof Error ? err.message : String(err);
					return new Response(`Couldn't get this label: ${why}`, {
						status: 502,
					});
				}
			},
		},
	},
});
