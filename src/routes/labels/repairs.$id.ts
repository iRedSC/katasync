import { createFileRoute } from "@tanstack/react-router";

// The 4x6 tickets for the tools left for repair, one each
// (src/printing/repair-ticket.tsx), printed as the repair is made and from
// its page; ?tool=<id> prints just that tool's.
export const Route = createFileRoute("/labels/repairs/$id")({
	server: {
		handlers: {
			GET: async ({ request, params }) => {
				const { getDb } = await import("#/db/client");
				const { repairTicket, renderRepairTicket } = await import(
					"#/printing/repair-ticket"
				);
				const id = Number(params.id);
				const tool = new URL(request.url).searchParams.get("tool");
				const toolId = tool === null ? undefined : Number(tool);
				const ticket =
					Number.isInteger(id) &&
					(toolId === undefined || Number.isInteger(toolId))
						? await repairTicket(getDb(), id, toolId)
						: null;
				if (!ticket)
					return new Response("No repair with that number", { status: 404 });
				const { originOf } = await import("#/auth/origin");
				const origin = originOf(request);
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
