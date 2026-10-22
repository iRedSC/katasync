import { extractText, getDocumentProxy } from "unpdf";

// A PDF's text, page by page, so Claude and SQL can read an invoice without
// the file. Null for scans (no text in them) and files that won't open.
// Every caller shares the limits below, so a batch of PDFs can't take all the
// memory or CPU at once, and one that stalls can't hold up the others.

// A longer PDF, or one still being read after this long, isn't read. Its text
// says so, so the gap is visible.
const MAX_PAGES = 150;
const MAX_MS = 20_000;
const SLOW = `--- Not read: still reading after ${MAX_MS / 1000}s ---`;
// How many are read at once.
const AT_ONCE = 2;

let reading = 0;
const queued: (() => void)[] = [];

// Waits for a free reader. The one finishing passes its place to the next in
// line, so the count never goes over AT_ONCE.
async function turn<T>(work: () => Promise<T>): Promise<T> {
	if (reading < AT_ONCE) reading++;
	else await new Promise<void>((go) => queued.push(go));
	try {
		return await work();
	} finally {
		const next = queued.shift();
		if (next) next();
		else reading--;
	}
}

export async function pdfText(data: Buffer) {
	return turn(() => readText(data)).catch(() => null);
}

async function readText(data: Buffer) {
	const pdf = await getDocumentProxy(new Uint8Array(data));
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			textOf(pdf),
			new Promise<string>((done) => {
				timer = setTimeout(() => done(SLOW), MAX_MS);
			}),
		]);
	} finally {
		clearTimeout(timer);
		// Stops any reading still going, so it doesn't run on in the background.
		await pdf.loadingTask.destroy();
	}
}

async function textOf(pdf: Awaited<ReturnType<typeof getDocumentProxy>>) {
	if (pdf.numPages > MAX_PAGES)
		return `--- Not read: ${pdf.numPages} pages, more than ${MAX_PAGES} ---`;
	const { text } = await extractText(pdf, { mergePages: false });
	const pages = text.map((p) => p.trim());
	if (pages.every((p) => p === "")) return null;
	return pages.map((p, i) => `--- Page ${i + 1} ---\n${p}`).join("\n\n");
}

export const isPdf = (contentType: string, filename: string) =>
	contentType === "application/pdf" || /\.pdf$/i.test(filename);
