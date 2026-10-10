import { createFileRoute } from "@tanstack/react-router";

// A TikTok label's PDF. TikTok's own links expire after about a day, so this
// asks TikTok for a fresh one each time and sends the browser there.
export const Route = createFileRoute("/labels/tiktok/$packageId")({
	server: {
		handlers: {
			GET: async ({ params }) => {
				const { tiktokLabel } = await import("#/shipping/tiktok");
				const { url } = await tiktokLabel(params.packageId);
				return Response.redirect(url, 302);
			},
		},
	},
});
