import { createFileRoute } from "@tanstack/react-router";

// A 4x6 test label, printed from Settings to check this computer's printer.
export const Route = createFileRoute("/labels/test")({
	server: {
		handlers: {
			GET: async () => {
				const { renderTestLabel } = await import("#/printing/test-label");
				return new Response(new Uint8Array(await renderTestLabel()), {
					headers: {
						"Content-Type": "application/pdf",
						"Content-Disposition": 'inline; filename="test-label.pdf"',
						"Cache-Control": "no-store",
					},
				});
			},
		},
	},
});
