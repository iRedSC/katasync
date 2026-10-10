import { createFileRoute } from "@tanstack/react-router";

// The PO as a PDF the browser shows in its own tab, to read or print. The
// same document is what gets emailed.
export const Route = createFileRoute("/purchasing/pdf/$id")({
	server: {
		handlers: {
			GET: async ({ params }) => {
				const [{ documentFor }, { PurchaseOrderError }, { getDb }] =
					await Promise.all([
						import("#/purchasing/load"),
						import("#/purchasing/orders"),
						import("#/db/client"),
					]);
				const id = Number(params.id);
				if (!Number.isInteger(id) || id <= 0)
					return new Response("Not a PO number", { status: 404 });
				const found = await documentFor(getDb(), id).catch((err) => {
					if (err instanceof PurchaseOrderError) return null;
					throw err;
				});
				if (!found) return new Response(`No PO ${id}`, { status: 404 });
				const { pdf, filename } = found;
				return new Response(new Uint8Array(pdf), {
					headers: {
						"Content-Type": "application/pdf",
						"Content-Disposition": `inline; filename="${filename}"`,
					},
				});
			},
		},
	},
});
