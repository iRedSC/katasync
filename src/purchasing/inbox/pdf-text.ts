import { extractText } from "unpdf";

// A PDF's text, page by page, so Claude and SQL can read an invoice without
// the file. Null for scans (no text in them) and files that won't open.
export async function pdfText(data: Buffer) {
	try {
		const { text } = await extractText(new Uint8Array(data), {
			mergePages: false,
		});
		const pages = text.map((p) => p.trim());
		if (pages.every((p) => p === "")) return null;
		return pages.map((p, i) => `--- Page ${i + 1} ---\n${p}`).join("\n\n");
	} catch {
		return null;
	}
}

export const isPdf = (contentType: string, filename: string) =>
	contentType === "application/pdf" || /\.pdf$/i.test(filename);
