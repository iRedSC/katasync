import { type } from "arktype";

// Reads the purchasing mailbox through Microsoft Graph, as an app with no
// user signed in (client credentials). Exchange limits the app to this one
// mailbox (an RBAC role scoped to it), so the token carries no Mail role of
// its own; checkInbox on Diagnostics fails if it ever does. Never touches the
// database, so the cron can ask "anything new?" without waking it.
//
//   MS_GRAPH_TENANT_ID, MS_GRAPH_CLIENT_ID, MS_GRAPH_CLIENT_SECRET
//   PO_INBOX   the mailbox, e.g. purchasing@eastcoastdrywall.com. Each PO is
//              sent with its own reply address in it: purchasing+po1234@...

export const INBOX_ENV = [
	"MS_GRAPH_TENANT_ID",
	"MS_GRAPH_CLIENT_ID",
	"MS_GRAPH_CLIENT_SECRET",
	"PO_INBOX",
] as const;

const GRAPH = "https://graph.microsoft.com/v1.0";

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

function credentials() {
	const tenant = process.env.MS_GRAPH_TENANT_ID;
	const client = process.env.MS_GRAPH_CLIENT_ID;
	const secret = process.env.MS_GRAPH_CLIENT_SECRET;
	const inbox = inboxAddress();
	if (!tenant || !client || !secret || !inbox)
		throw new InboxNotConfiguredError(
			`The purchasing inbox isn't set up: set ${INBOX_ENV.join(", ")}`,
		);
	return { tenant, client, secret, inbox };
}

const tokenResponse = type({
	access_token: "string",
	expires_in: "number",
});

let cached: { token: string; until: number } | null = null;

export async function graphToken() {
	if (cached && cached.until > Date.now()) return cached.token;
	const { tenant, client, secret } = credentials();
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

const address = type({
	emailAddress: { "address?": "string", "name?": "string" },
});

const messageSummary = type({
	id: "string",
	"internetMessageId?": "string | null",
	receivedDateTime: "string",
	"subject?": "string | null",
	"from?": address.or("null"),
	"toRecipients?": address.array(),
	"ccRecipients?": address.array(),
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

const addressOf = (a: typeof address.infer) =>
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

const mailbox = () => `/users/${encodeURIComponent(credentials().inbox)}`;

// Pages a search reads at most looking for matches the filter keeps.
const MAX_SEARCH_PAGES = 20;

// Follows Graph's pages until `limit` messages pass `keep`, or there are no
// more (or, for a filtered search, MAX_SEARCH_PAGES were read).
async function pages(
	first: string,
	limit = Number.POSITIVE_INFINITY,
	keep?: (m: InboxMessage) => boolean,
) {
	const ours = ourAddresses(credentials().inbox);
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

// Emails that reached the inbox since `since`, newest first, leaving out
// drafts and anything we sent. Asks Graph only.
export async function messagesSince(since: Date): Promise<InboxMessage[]> {
	const all = await pages(
		`${mailbox()}/messages?$filter=receivedDateTime ge ${since.toISOString()}&$orderby=receivedDateTime desc&$select=${SELECT}&$top=50`,
	);
	return all.filter((m) => !m.ours).map(({ ours: _, ...m }) => m);
}

// The whole mailbox, every folder, for Claude: by words (Outlook's search:
// sender, subject, body, attachment names) or newest first in a date range.
// Includes what we sent, marked `ours`.
export async function searchMailbox(input: {
	words?: string;
	since?: Date;
	until?: Date;
	limit: number;
}) {
	const top = Math.min(input.limit, 50);
	if (input.words) {
		// Graph can't sort or filter by date alongside a word search, so the
		// dates are applied here, reading on until enough pass.
		const words = input.words.replace(/"/g, "");
		const { since, until } = input;
		return pages(
			`${mailbox()}/messages?$search="${encodeURIComponent(words)}"&$select=${SELECT}&$top=${top}`,
			input.limit,
			since || until
				? (m) =>
						(!since || m.receivedAt >= since) &&
						(!until || m.receivedAt < until)
				: undefined,
		);
	}
	const range = [
		input.since && `receivedDateTime ge ${input.since.toISOString()}`,
		input.until && `receivedDateTime lt ${input.until.toISOString()}`,
	].filter(Boolean);
	const filter = range.length > 0 ? `$filter=${range.join(" and ")}&` : "";
	return pages(
		`${mailbox()}/messages?${filter}$orderby=receivedDateTime desc&$select=${SELECT}&$top=${top}`,
		input.limit,
	);
}

// One email by Graph id, as searchMailbox lists it.
export async function mailboxMessage(graphId: string) {
	const m = messageSummary.assert(
		await (
			await graph(
				`${mailbox()}/messages/${encodeURIComponent(graphId)}?$select=${SELECT}`,
			)
		).json(),
	);
	return toMessage(m, ourAddresses(credentials().inbox));
}

// Files larger than this keep their name and size only.
export const MAX_ATTACHMENT_BYTES = 15_000_000;

export type InboxAttachment = {
	filename: string;
	contentType: string;
	size: number;
	data: Buffer | null;
};

const attachmentList = type({
	value: type({
		"@odata.type": "string",
		id: "string",
		"name?": "string | null",
		"contentType?": "string | null",
		size: "number",
		"isInline?": "boolean",
	}).array(),
});

// The body as plain text, and the files attached (not pictures inside it).
export async function messageContent(graphId: string) {
	const base = `${mailbox()}/messages/${encodeURIComponent(graphId)}`;
	const { body } = type({ body: { content: "string" } }).assert(
		await (
			await graph(`${base}?$select=body`, {
				headers: { Prefer: 'outlook.body-content-type="text"' },
			})
		).json(),
	);
	const list = attachmentList.assert(
		await (
			await graph(
				`${base}/attachments?$select=id,name,contentType,size,isInline`,
			)
		).json(),
	);
	const attachments: InboxAttachment[] = [];
	for (const a of list.value) {
		// Item attachments (a forwarded email) and links to OneDrive files have
		// no bytes of their own here.
		if (a["@odata.type"] !== "#microsoft.graph.fileAttachment" || a.isInline)
			continue;
		let data: Buffer | null = null;
		if (a.size <= MAX_ATTACHMENT_BYTES) {
			const res = await graph(
				`${base}/attachments/${encodeURIComponent(a.id)}/$value`,
			);
			data = Buffer.from(await res.arrayBuffer());
		}
		attachments.push({
			filename: a.name?.trim() || "attachment",
			contentType: a.contentType?.toLowerCase() || "application/octet-stream",
			size: data ? data.length : a.size,
			data,
		});
	}
	return { body: body.content.trim(), attachments };
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
