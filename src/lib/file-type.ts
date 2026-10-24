// What a file is, from what its sender says and what it's called. Browsers
// send no type for some files (.eml on Windows), and some mailers label every
// attachment application/octet-stream (Dura-Stilts' PDFs), so the name
// decides then.
export function fileType(contentType: string, filename: string) {
	const given = contentType.split(";")[0].trim().toLowerCase();
	if (given && given !== "application/octet-stream") return given;
	if (/\.pdf$/i.test(filename)) return "application/pdf";
	if (/\.eml$/i.test(filename)) return "message/rfc822";
	if (/\.png$/i.test(filename)) return "image/png";
	if (/\.jpe?g$/i.test(filename)) return "image/jpeg";
	return "application/octet-stream";
}
