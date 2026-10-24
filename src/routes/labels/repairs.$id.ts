import { createFileRoute } from "@tanstack/react-router";

// The 4x6 ticket for a tool left for repair (src/printing/repair-ticket.tsx),
// printed as the repair is made and from its page.
export const Route = createFileRoute("/labels/repairs/$id")({
	server: {
		handlers: {
			GET: async ({ request, params }) => {
				const { getDb } = await import("#/db/client");
				const { repairTicket, renderRepairTicket } = await import(
					"#/printing/repair-ticket"
				);
				const id = Number(params.id);
				const ticket = Number.isInteger(id)
					? await repairTicket(getDb(), id)
					: null;
				if (!ticket)
					return new Response("No repair with that number", { status: 404 });
				const origin = process.env.AUTH_ORIGIN ?? new URL(request.url).origin;
				const pdf = await renderRepairTicket(ticket, origin);
				return new Response(new Uint8Array(pdf), {
					headers: {
						"Content-Type": "application/pdf",
						"Content-Disposition": `inline; filename*=UTF-8''${encodeURIComponent(`R${ticket.id}.pdf`)}`,
						"Cache-Control": "no-store",
					},
				});
			},
		},
	},
});
