// A kept file as the browser gets it. PDFs and images open in the page; the
// rest download. Whoever sent it, it runs nothing on our origin.
export function fileResponse(
	file: {
		filename: string;
		contentType: string;
		data: Buffer;
	},
	range?: string | null,
) {
	const audio =
		/^audio\/(mpeg|mp3|x-mp3)$/.test(file.contentType) ||
		/\.mp3$/i.test(file.filename);
	const inline =
		file.contentType === "application/pdf" ||
		/^image\/(png|jpeg|gif|webp)$/.test(file.contentType) ||
		audio;
	const contentType = audio ? "audio/mpeg" : file.contentType;
	const headers: Record<string, string> = {
		"Content-Type": inline ? contentType : "application/octet-stream",
		"Content-Disposition": `${inline ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(file.filename)}`,
		"X-Content-Type-Options": "nosniff",
		"Content-Security-Policy": "sandbox",
		"Cache-Control": "private, max-age=3600",
		"Accept-Ranges": "bytes",
	};
	if (!range)
		return new Response(new Uint8Array(file.data), {
			headers: { ...headers, "Content-Length": String(file.data.length) },
		});
	const match = /^bytes=(\d*)-(\d*)$/.exec(range);
	const length = file.data.length;
	const start = match?.[1]
		? Number(match[1])
		: Math.max(0, length - Number(match?.[2]));
	const end =
		match?.[1] && match[2]
			? Math.min(Number(match[2]), length - 1)
			: length - 1;
	if (
		!match ||
		(!match[1] && !match[2]) ||
		!Number.isSafeInteger(start) ||
		!Number.isSafeInteger(end) ||
		start < 0 ||
		start >= length ||
		end < start
	)
		return new Response(null, {
			status: 416,
			headers: { ...headers, "Content-Range": `bytes */${length}` },
		});
	const data = file.data.subarray(start, end + 1);
	return new Response(new Uint8Array(data), {
		status: 206,
		headers: {
			...headers,
			"Content-Length": String(data.length),
			"Content-Range": `bytes ${start}-${end}/${length}`,
		},
	});
}
