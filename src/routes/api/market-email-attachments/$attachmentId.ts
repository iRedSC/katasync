import { createFileRoute } from "@tanstack/react-router";

// A file a marketplace emailed, from the app, which has a session (the sign-in
// guard refuses this without one). PDFs and images open in the browser.
export const Route = createFileRoute(
	"/api/market-email-attachments/$attachmentId",
)({
	server: {
		handlers: {
			GET: async ({ params }) => {
				const [{ marketAttachment }, { getDb }] = await Promise.all([
					import("#/inbox/market-mail"),
					import("#/db/client"),
				]);
				const id = Number(params.attachmentId);
				if (!Number.isInteger(id) || id <= 0)
					return new Response("Not an attachment number", { status: 404 });
				const file = await marketAttachment(getDb(), id);
				if (!file) return new Response("No such attachment", { status: 404 });
				if (!file.data)
					return new Response("Too large to keep; open it in Outlook", {
						status: 404,
					});
				const inline =
					file.contentType === "application/pdf" ||
					/^image\/(png|jpeg|gif|webp)$/.test(file.contentType);
				return new Response(new Uint8Array(file.data), {
					headers: {
						"Content-Type": inline
							? file.contentType
							: "application/octet-stream",
						"Content-Disposition": `${inline ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(file.filename)}`,
						"X-Content-Type-Options": "nosniff",
						// A marketplace's file runs nothing on our origin.
						"Content-Security-Policy": "sandbox",
						"Cache-Control": "private, max-age=3600",
					},
				});
			},
		},
	},
});
