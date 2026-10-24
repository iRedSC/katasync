import { type } from "arktype";
import { fileType } from "#/lib/file-type";

// Reads the purchasing mailbox through Microsoft Graph, as an app with no
// user signed in (client credentials). Exchange limits the app to this one
// mailbox (an RBAC role scoped to it), so the token carries no Mail role of
// its own; checkInbox on Diagnostics fails if it ever does. Never touches the
// database, so the cron can ask "anything new?" without waking it.
//
//   MS_GRAPH_TENANT_ID, MS_GRAPH_CLIENT_ID, MS_GRAPH_CLIENT_SECRET
//   PO_INBOX   the mailbox, e.g. purchasing@eastcoastdrywall.com. Each PO is
//              sent with its own reply address in it: purchasing+po1234@...
//   MARKETPLACE_INBOX  where the marketplaces send their notices,
//              marketplaces@eastcoastdrywall.com; read the same way, through
//              a second RBAC scope. Only Claude reads it (src/mcp/server).

export const INBOX_ENV = [
	"MS_GRAPH_TENANT_ID",
	"MS_GRAPH_CLIENT_ID",
	"MS_GRAPH_CLIENT_SECRET",
	"PO_INBOX",
] as const;

const GRAPH = "https://graph.microsoft.com/v1.0";

// The mailboxes katasync reads. Purchasing is the PO inbox; marketplaces
// holds Amazon's, TikTok's, and eBay's notices.
export type Mailbox = "purchasing" | "marketplaces";

export class InboxNotConfiguredError extends Error {
	name = "InboxNotConfiguredError";
}

export function inboxAddress() {
	const inbox = process.env.PO_INBOX?.trim().toLowerCase();
	return inbox && /^[^@\s+]+@[^@\s]+$/.test(inbox) ? inbox : null;
}

// The address a PO is sent with, so replies to it land on it. Null when the
// inbox isn't set up.
export function poAddress(purchaseOrderId: number) {
	const inbox = inboxAddress();
	if (!inbox) return null;
	const [local, domain] = inbox.split("@");
	return `${local}+po${purchaseOrderId}@${domain}`;
}

// The PO an address names, if it's one of ours.
export function poOfAddress(address: string) {
	const inbox = inboxAddress();
	if (!inbox) return null;
	const [local, domain] = inbox.split("@");
	const m = /^([^@+]+)\+po(\d{1,9})@(.+)$/i.exec(address.trim());
	if (!m) return null;
	if (m[1].toLowerCase() !== local || m[3].toLowerCase() !== domain)
		return null;
	return Number(m[2]);
}

function appCredentials() {
	const tenant = process.env.MS_GRAPH_TENANT_ID;
	const client = process.env.MS_GRAPH_CLIENT_ID;
	const secret = process.env.MS_GRAPH_CLIENT_SECRET;
	if (!tenant || !client || !secret)
		throw new InboxNotConfiguredError(
			`The purchasing inbox isn't set up: set ${INBOX_ENV.join(", ")}`,
		);
	return { tenant, client, secret };
}

function credentials() {
	const inbox = inboxAddress();
	if (!inbox)
		throw new InboxNotConfiguredError(
			`The purchasing inbox isn't set up: set ${INBOX_ENV.join(", ")}`,
		);
	return { ...appCredentials(), inbox };
}

const address = (box: Mailbox) => {
	if (box === "purchasing") return credentials().inbox;
	const inbox = process.env.MARKETPLACE_INBOX?.trim().toLowerCase();
	if (!inbox || !/^[^@\s+]+@[^@\s]+$/.test(inbox))
		throw new InboxNotConfiguredError(
			"The marketplaces mailbox isn't set up: set MARKETPLACE_INBOX, e.g. marketplaces@eastcoastdrywall.com",
		);
	appCredentials();
	return inbox;
};

const tokenResponse = type({
	access_token: "string",
	expires_in: "number",
});

let cached: { token: string; until: number } | null = null;

export async function graphToken() {
	if (cached && cached.until > Date.now()) return cached.token;
	const { tenant, client, secret } = appCredentials();
	const res = await fetch(
		`https://login.microsoftonline.com/${tenant}/oauth2/v2.0/token`,
		{
			method: "POST",
			body: new URLSearchParams({
				client_id: client,
				client_secret: secret,
				scope: "https://graph.microsoft.com/.default",
				grant_type: "client_credentials",
			}),
		},
	);
	const body = (await res.json().catch(() => null)) as {
		error_description?: string;
	} | null;
	if (!res.ok) {
		const why = body?.error_description?.split("\r\n")[0] ?? res.statusText;
		// AADSTS7000222: the client secret expired.
		throw new Error(
			/AADSTS7000222/.test(why)
				? "The Microsoft 365 client secret expired. Make a new one in Entra (App registrations, KataSync mail, Certificates & secrets) and put it in MS_GRAPH_CLIENT_SECRET."
				: `Microsoft sign-in failed: ${why}`,
		);
	}
	const { access_token, expires_in } = tokenResponse.assert(body);
	// A minute early, so a token never expires mid-request.
	cached = {
		token: access_token,
		until: Date.now() + (expires_in - 60) * 1000,
	};
	return access_token;
}

// The app roles a token carries. A Mail role means Entra grants it every
// mailbox, not just the purchasing one.
export function tokenRoles(token: string): string[] {
	const payload = token.split(".")[1] ?? "";
	const json = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
	return Array.isArray(json.roles) ? json.roles : [];
}

async function graph(path: string, init?: { headers?: HeadersInit }) {
	const token = await graphToken();
	const res = await fetch(path.startsWith("https://") ? path : GRAPH + path, {
		headers: { Authorization: `Bearer ${token}`, ...init?.headers },
	});
	if (!res.ok) {
		const text = await res.text();
		let why = text;
		try {
			why = JSON.parse(text).error?.message ?? text;
		} catch {}
		throw new Error(`Microsoft 365 answered ${res.status}: ${why}`);
	}
	return res;
}

const emailAddress = type({
	emailAddress: { "address?": "string", "name?": "string" },
});

const messageSummary = type({
	id: "string",
	"internetMessageId?": "string | null",
	receivedDateTime: "string",
	"subject?": "string | null",
	"from?": emailAddress.or("null"),
	"toRecipients?": emailAddress.array(),
	"ccRecipients?": emailAddress.array(),
	"isDraft?": "boolean",
});

export type InboxMessage = {
	graphId: string;
	messageId: string;
	receivedAt: Date;
	subject: string;
	fromAddress: string;
	fromName: string | null;
	recipients: string[];
};

const addressOf = (a: typeof emailAddress.infer) =>
	a.emailAddress.address?.trim().toLowerCase() ?? "";

// Who we send as, so copies of our own POs aren't read in as replies.
function ourAddresses(inbox: string) {
	const from =
		/<([^>]+)>/.exec(process.env.PO_EMAIL_FROM ?? "")?.[1] ??
		process.env.PO_EMAIL_FROM;
	return new Set(
		[inbox, from].filter(Boolean).map((a) => (a as string).toLowerCase()),
	);
}

const SELECT =
	"id,internetMessageId,receivedDateTime,subject,from,toRecipients,ccRecipients,isDraft";

function toMessage(m: typeof messageSummary.infer, ours: Set<string>) {
	const from = m.from ? addressOf(m.from) : "";
	return {
		graphId: m.id,
		// Graph's id changes when the email moves folders; Message-ID doesn't.
		messageId: m.internetMessageId ?? m.id,
		receivedAt: new Date(m.receivedDateTime),
		subject: m.subject ?? "",
		fromAddress: from,
		fromName: m.from?.emailAddress.name?.trim() || null,
		recipients: [...(m.toRecipients ?? []), ...(m.ccRecipients ?? [])]
			.map(addressOf)
			.filter(Boolean),
		// Sent by us (a copy of a PO, a staff reply) or never sent.
		ours: Boolean(m.isDraft) || !from || ours.has(from),
	};
}

const mailbox = (box: Mailbox = "purchasing") =>
	`/users/${encodeURIComponent(address(box))}`;

// Pages a search reads at most looking for matches the filter keeps.
const MAX_SEARCH_PAGES = 20;

// Follows Graph's pages until `limit` messages pass `keep`, or there are no
// more (or, for a filtered search, MAX_SEARCH_PAGES were read).
async function pages(
	first: string,
	limit = Number.POSITIVE_INFINITY,
	keep?: (m: InboxMessage) => boolean,
	box: Mailbox = "purchasing",
) {
	const ours = ourAddresses(address(box));
	const found: (InboxMessage & { ours: boolean })[] = [];
	let next: string | null = first;
	let read = 0;
	while (next && found.length < limit) {
		if (keep && read++ >= MAX_SEARCH_PAGES) break;
		const page = type({
			value: messageSummary.array(),
			"@odata.nextLink?": "string",
		}).assert(await (await graph(next)).json());
		for (const m of page.value) {
			const message = toMessage(m, ours);
			if (!keep || keep(message)) found.push(message);
		}
		next = page["@odata.nextLink"] ?? null;
	}
	return found.slice(0, limit);
}

// Emails that reached a mailbox since `since`, newest first, leaving out
// drafts and anything we sent, except what `keepOurs` asks for (a notice a
// service sends as us). Asks Graph only.
export async function messagesSince(
	since: Date,
	box: Mailbox = "purchasing",
	keepOurs?: (m: InboxMessage) => boolean,
): Promise<InboxMessage[]> {
	const all = await pages(
		`${mailbox(box)}/messages?$filter=receivedDateTime ge ${since.toISOString()}&$orderby=receivedDateTime desc&$select=${SELECT}&$top=50`,
		undefined,
		undefined,
		box,
	);
	return all
		.map(({ ours, ...m }) => ({ ours, m }))
		.filter(({ ours, m }) => !ours || keepOurs?.(m))
		.map(({ m }) => m);
}

// The whole mailbox, every folder, for Claude: by words (Outlook's search:
// sender, subject, body, attachment names) or newest first in a date range.
// Includes what we sent, marked `ours`.
export async function searchMailbox(input: {
	box?: Mailbox;
	words?: string;
	since?: Date;
	until?: Date;
	limit: number;
}) {
	const box = input.box ?? "purchasing";
	const top = Math.min(input.limit, 50);
	if (input.words) {
		// Graph can't sort or filter by date alongside a word search, so the
		// dates are applied here, reading on until enough pass.
		const words = input.words.replace(/"/g, "");
		const { since, until } = input;
		return pages(
			`${mailbox(box)}/messages?$search="${encodeURIComponent(words)}"&$select=${SELECT}&$top=${top}`,
			input.limit,
			since || until
				? (m) =>
						(!since || m.receivedAt >= since) &&
						(!until || m.receivedAt < until)
				: undefined,
			box,
		);
	}
	const range = [
		input.since && `receivedDateTime ge ${input.since.toISOString()}`,
		input.until && `receivedDateTime lt ${input.until.toISOString()}`,
	].filter(Boolean);
	const filter = range.length > 0 ? `$filter=${range.join(" and ")}&` : "";
	return pages(
		`${mailbox(box)}/messages?${filter}$orderby=receivedDateTime desc&$select=${SELECT}&$top=${top}`,
		input.limit,
		undefined,
		box,
	);
}

// One email by Graph id, as searchMailbox lists it.
export async function mailboxMessage(
	graphId: string,
	box: Mailbox = "purchasing",
) {
	const m = messageSummary.assert(
		await (
			await graph(
				`${mailbox(box)}/messages/${encodeURIComponent(graphId)}?$select=${SELECT}`,
			)
		).json(),
	);
	return toMessage(m, ourAddresses(address(box)));
}

// Files larger than this keep their name and size only.
export const MAX_ATTACHMENT_BYTES = 15_000_000;
// What all of an email's files may bring in together, and how many. Past
// either, a file keeps its name and size only, as one too big does.
const MAX_MESSAGE_BYTES = 30_000_000;
const MAX_MESSAGE_FILES = 25;
// A picture the HTML doesn't show, this small or less, is a signature logo.
const LOGO_BYTES = 100_000;

export type InboxAttachment = {
	filename: string;
	contentType: string;
	size: number;
	data: Buffer | null;
};

// A picture shown inside the email, which its HTML names as cid:<contentId>.
export type InlinePicture = InboxAttachment & { contentId: string };

const attachmentList = type({
	value: type({
		"@odata.type": "string",
		id: "string",
		"name?": "string | null",
		"contentType?": "string | null",
		size: "number",
		"isInline?": "boolean",
	}).array(),
	"@odata.nextLink?": "string",
});
type AttachmentEntry = (typeof attachmentList.infer)["value"][number];

// Every attachment of an email, across Graph's pages: a file past the first
// page is kept like any other, since a later sweep won't read the email again.
async function attachmentsOf(base: string) {
	const found: AttachmentEntry[] = [];
	let next: string | null =
		`${base}/attachments?$select=id,name,contentType,size,isInline`;
	while (next) {
		const page = attachmentList.assert(await (await graph(next)).json());
		found.push(...page.value);
		next = page["@odata.nextLink"] ?? null;
	}
	return found;
}

// The files whose bytes an email brings in, by id. Whole files go first, then
// pictures, and the rest of the email's files keep their name and size only.
// Graph's sizes decide, before any bytes are read.
function fetchedIds(list: AttachmentEntry[]) {
	const files = list.filter(
		(a) =>
			a["@odata.type"] === "#microsoft.graph.fileAttachment" ||
			a["@odata.type"] === "#microsoft.graph.itemAttachment",
	);
	const ordered = [
		...files.filter((a) => !a.isInline),
		...files.filter((a) => a.isInline),
	];
	const ids = new Set<string>();
	let bytes = 0;
	for (const a of ordered) {
		if (
			a.size > MAX_ATTACHMENT_BYTES ||
			ids.size >= MAX_MESSAGE_FILES ||
			bytes + a.size > MAX_MESSAGE_BYTES
		)
			continue;
		ids.add(a.id);
		bytes += a.size;
	}
	return ids;
}

const isPicture = (a: AttachmentEntry) => /^image\//i.test(a.contentType ?? "");

// One file attached, with its bytes and, for a picture, the cid: its HTML
// names it by. Only one by one: the list is typed as any attachment, and
// Graph refuses a $select of a file's own fields (contentId, contentBytes)
// there and fails the whole request.
const fileAttachment = type({
	contentBytes: "string",
	"contentId?": "string | null",
});

// The body as plain text (for search, lists, and Claude) and as sent (to
// read formatted), the files attached, and the pictures inside it.
export async function messageContent(
	graphId: string,
	box: Mailbox = "purchasing",
) {
	const base = `${mailbox(box)}/messages/${encodeURIComponent(graphId)}`;
	const [text, formatted] = await Promise.all([
		bodyOf(base, "text"),
		messageHtml(graphId, box),
	]);
	return { body: text.trim(), ...formatted };
}

async function bodyOf(base: string, as: "text" | "html") {
	const { body } = type({ body: { content: "string" } }).assert(
		await (
			await graph(`${base}?$select=body`, {
				headers: { Prefer: `outlook.body-content-type="${as}"` },
			})
		).json(),
	);
	return body.content;
}

// The email as sent, and its files and pictures; for an email kept before
// katasync kept HTML, without the rest.
export async function messageHtml(graphId: string, box: Mailbox) {
	const base = `${mailbox(box)}/messages/${encodeURIComponent(graphId)}`;
	const [html, list] = await Promise.all([
		bodyOf(base, "html"),
		attachmentsOf(base),
	]);
	const fetched = fetchedIds(list);
	const attachments: InboxAttachment[] = [];
	const inline: InlinePicture[] = [];
	for (const a of list) {
		if (a["@odata.type"] === "#microsoft.graph.itemAttachment") {
			const email = await attachedEmail(base, a, fetched.has(a.id));
			if (email) attachments.push(email);
			continue;
		}
		// Links to OneDrive files have no bytes of their own here.
		if (a["@odata.type"] !== "#microsoft.graph.fileAttachment") continue;
		let data: Buffer | null = null;
		let contentId: string | null = null;
		if (fetched.has(a.id)) {
			const one = fileAttachment.assert(
				await (
					await graph(`${base}/attachments/${encodeURIComponent(a.id)}`)
				).json(),
			);
			data = Buffer.from(one.contentBytes, "base64");
			contentId = one.contentId?.replace(/^<|>$/g, "").trim() || null;
		}
		// A small picture the HTML doesn't show is a signature logo, left out.
		// Anything else inline (a scan, a PDF) is a document, so it's kept.
		const shown = contentId !== null && html.includes(`cid:${contentId}`);
		if (a.isInline && !shown && isPicture(a) && a.size <= LOGO_BYTES) continue;
		const name = a.name?.trim() || "attachment";
		const file = {
			filename: name,
			contentType: fileType(a.contentType ?? "", name),
			size: data ? data.length : a.size,
			data,
		};
		if (shown && contentId) inline.push({ ...file, contentId });
		else attachments.push(file);
	}
	return { html, attachments, inline };
}

// An email attached to an email (Outlook's "attach as item", as suppliers
// forward a carrier's or their own office's), as the .eml it would save as,
// so it reads like any other. Graph gives an item's MIME only for an email;
// an attached calendar invite or contact is left out.
async function attachedEmail(
	base: string,
	a: AttachmentEntry,
	bytes: boolean,
): Promise<InboxAttachment | null> {
	const name = `${(a.name?.trim() || "Attached email").replace(/[/\\]/g, "_")}.eml`;
	const file = { filename: name, contentType: "message/rfc822" };
	if (!bytes) return { ...file, size: a.size, data: null };
	const res = await graph(
		`${base}/attachments/${encodeURIComponent(a.id)}/$value`,
	).catch((error: Error) => {
		// Refused for what it is (not an email); anything else, like a busy
		// Graph, fails the read so the email is read again next run.
		if (/answered 4(?!29)\d\d/.test(error.message)) return null;
		throw error;
	});
	if (!res) return null;
	const data = Buffer.from(await res.arrayBuffer());
	if (data.length === 0) return null;
	return { ...file, size: data.length, data };
}

// An email's Graph id from the Message-ID katasync kept, or null if it's
// gone from the mailbox. Kept ids without angle brackets are Graph's own.
export async function findMessage(messageId: string, box: Mailbox) {
	if (!messageId.startsWith("<")) return messageId;
	const page = type({ value: type({ id: "string" }).array() }).assert(
		await (
			await graph(
				`${mailbox(box)}/messages?$filter=internetMessageId eq '${encodeURIComponent(messageId.replace(/'/g, "''"))}'&$select=id&$top=1`,
			)
		).json(),
	);
	return page.value[0]?.id ?? null;
}

// For Diagnostics: the newest email's time, which proves the mailbox reads.
export async function newestMessageAt() {
	const { inbox } = credentials();
	const page = type({
		value: type({ receivedDateTime: "string" }).array(),
	}).assert(
		await (
			await graph(
				`/users/${encodeURIComponent(inbox)}/messages?$top=1&$select=receivedDateTime&$orderby=receivedDateTime desc`,
			)
		).json(),
	);
	return page.value[0] ? new Date(page.value[0].receivedDateTime) : null;
}
