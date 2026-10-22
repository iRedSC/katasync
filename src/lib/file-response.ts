// A kept file as the browser gets it. PDFs and images open in the page; the
// rest download. Whoever sent it, it runs nothing on our origin.
export function fileResponse(file: {
	filename: string;
	contentType: string;
	data: Buffer;
}) {
	const inline =
		file.contentType === "application/pdf" ||
		/^image\/(png|jpeg|gif|webp)$/.test(file.contentType);
	return new Response(new Uint8Array(file.data), {
		headers: {
			"Content-Type": inline ? file.contentType : "application/octet-stream",
			"Content-Disposition": `${inline ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(file.filename)}`,
			"X-Content-Type-Options": "nosniff",
			"Content-Security-Policy": "sandbox",
			"Cache-Control": "private, max-age=3600",
		},
	});
}
