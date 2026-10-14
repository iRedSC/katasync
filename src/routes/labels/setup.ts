import { createFileRoute } from "@tanstack/react-router";

// The script that sets up label printing on a Windows packing computer, with
// katasync's QZ Tray certificate in it. Settings links here.
export const Route = createFileRoute("/labels/setup")({
	server: {
		handlers: {
			GET: async () => {
				const [{ getQzCertificate, qzSetupScript }, { getDb }] =
					await Promise.all([import("#/printing/qz"), import("#/db/client")]);
				const { certificate } = await getQzCertificate(getDb());
				return new Response(qzSetupScript(certificate), {
					headers: {
						"Content-Type": "application/octet-stream",
						"Content-Disposition":
							'attachment; filename="katasync-printing-setup.bat"',
						"Cache-Control": "no-store",
					},
				});
			},
		},
	},
});
