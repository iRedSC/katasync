import type { InboxAttachment } from "#/purchasing/inbox/graph";
import { isPdf, pdfText } from "#/purchasing/inbox/pdf-text";

// An email's attachments as an MCP client sees them, for every mailbox
// Claude reads (the purchasing inbox, the marketplaces one).

// Files sent back whole; bigger ones are described instead.
const MAX_FILE_BYTES = 8_000_000;
const IMAGE = /^image\/(png|jpeg|gif|webp)$/;

type Content =
	| { type: "text"; text: string }
	| { type: "image"; data: string; mimeType: string }
	| {
			type: "resource";
			resource: { uri: string; mimeType: string; blob: string };
	  };

// One attachment as the client can see it: an image or a PDF itself, its
// text, or why neither.
export function fileContent(
	uri: string,
	f: { filename: string; contentType: string; data: Buffer | null },
	text: string | null,
): Content[] {
	const out: Content[] = [];
	if (!f.data)
		out.push({
			type: "text",
			text: `${f.filename} is too large to keep; open it in Outlook.`,
		});
	else if (f.data.length > MAX_FILE_BYTES)
		out.push({
			type: "text",
			text: `${f.filename} is ${Math.round(f.data.length / 1e6)} MB, too large to send here.`,
		});
	else if (IMAGE.test(f.contentType))
		out.push({
			type: "image",
			data: f.data.toString("base64"),
			mimeType: f.contentType,
		});
	else if (isPdf(f.contentType, f.filename))
		out.push({
			type: "resource",
			resource: {
				uri,
				mimeType: "application/pdf",
				blob: f.data.toString("base64"),
			},
		});
	if (text) out.push({ type: "text", text: `Text of ${f.filename}:\n${text}` });
	else if (
		f.data &&
		!IMAGE.test(f.contentType) &&
		!isPdf(f.contentType, f.filename)
	)
		out.push({
			type: "text",
			text: `${f.filename} (${f.contentType}) can't be shown here.`,
		});
	return out;
}

export const describeFile = (
	a: { filename: string; contentType: string; size: number },
	extra: Record<string, unknown>,
) => ({ filename: a.filename, type: a.contentType, bytes: a.size, ...extra });

// Live attachments, with PDF text read now (they aren't kept).
export async function liveFiles(attachments: InboxAttachment[]) {
	return Promise.all(
		attachments.map(async (a) => ({
			...a,
			text:
				a.data && isPdf(a.contentType, a.filename)
					? await pdfText(a.data)
					: null,
		})),
	);
}
