import { randomBytes } from "node:crypto";

// Which Shopify thread a buyer's email answers (./shopify-mail.ts files it).
// Nothing here guesses: an email that could be about something else stays
// unmatched in the marketplaces mailbox, for someone to read.

const ADDRESS = /^[^@\s+]+@[^@\s]+$/;

export function inbox() {
	const box = process.env.MARKETPLACE_INBOX?.trim().toLowerCase();
	return box && ADDRESS.test(box) ? box : null;
}

// A thread's reply address carries its random token (shopify_threads),
// marketplaces+so<16 hex>@, so one can't be guessed or made up by counting.
export const newReplyToken = () => randomBytes(8).toString("hex");

// The address a thread's emails ask to be answered at.
export function threadAddress(replyToken: string) {
	const box = inbox();
	if (!box) return null;
	const [local, domain] = box.split("@");
	return `${local}+so${replyToken}@${domain}`;
}

// What an address is to us: not a thread address at all, or one shaped like
// ours with the token it carries (which may be no thread's).
export function readThreadAddress(
	address: string,
): { kind: "other" } | { kind: "token"; token: string } {
	const box = inbox();
	if (!box) return { kind: "other" };
	const [local, domain] = box.split("@");
	const a = address.trim().toLowerCase();
	if (!a.startsWith(`${local}+so`) || !a.endsWith(`@${domain}`))
		return { kind: "other" };
	return {
		kind: "token",
		token: a.slice(local.length + 3, -domain.length - 1),
	};
}

// What the buyer wrote, apart from the email they answered or passed on.
// Their own is empty when the email starts with what it quotes.
export function splitQuoted(body: string) {
	const text = body.replace(/\r\n/g, "\n");
	const quote =
		/^(On .{4,200}wrote:\s*$|-{2,}\s*(Original|Forwarded) Message\s*-{2,}|Begin forwarded message:|_{10,}\s*$|From:\s.+$|Sent from my )/im.exec(
			text,
		);
	const own = (quote ? text.slice(0, quote.index) : text)
		.split("\n")
		.filter((line) => !/^\s*>/.test(line))
		.join("\n")
		.trim();
	return { own, whole: text.trim() };
}

// The buyer's words for the thread: their own, or the whole email when
// nothing is theirs alone.
export const replyText = (body: string) => {
	const { own, whole } = splitQuoted(body);
	return own || whole;
};

// Shopify order names an email gives, "#5536", once each.
export function orderNames(text: string) {
	return [
		...new Set(
			[...text.matchAll(/(?<![\w#])#(\d{3,})(?!\d)/g)].map((m) => `#${m[1]}`),
		),
	];
}

export type ShopifyThreadRef = {
	id: number;
	// Its reply address's token; null when it has none, so no address names it.
	replyToken: string | null;
	email: string;
	orderName: string;
	open: boolean;
	createdAt: Date;
};

// One of the buyer's orders, by its email, threaded or not.
export type BuyerOrderRef = { email: string; name: string };

export type BuyerEmail = {
	fromAddress: string;
	senderAuthenticated: boolean;
	recipients: string[];
	subject: string;
	body: string;
	receivedAt: Date;
};

export type ReplyMatch =
	| { threadId: number; by: "address" | "order" | "sender" }
	| { threadId: null; why: string };

// The order an email is about, by what it names in its subject and the
// buyer's own words (never in what it quotes).
type Reference =
	| { kind: "none" }
	| { kind: "thread"; threadId: number }
	| { kind: "unthreaded" | "not theirs" | "several"; why: string };

function reference(
	email: BuyerEmail,
	theirs: ShopifyThreadRef[],
	orders: BuyerOrderRef[],
	sender: string,
): Reference {
	const names = orderNames(`${email.subject}\n${splitQuoted(email.body).own}`);
	if (names.length === 0) return { kind: "none" };
	if (names.length > 1)
		return { kind: "several", why: `it names ${names.join(", ")}` };
	const [name] = names;
	if (!orders.some((o) => o.email === sender && o.name === name))
		return { kind: "not theirs", why: `${name} isn't their order` };
	const thread = theirs.find((t) => t.orderName === name);
	return thread
		? { kind: "thread", threadId: thread.id }
		: { kind: "unthreaded", why: `${name} has no conversation yet` };
}

// Which thread a buyer's email answers. Only from a sender Microsoft
// vouched for, after the thread started. Its one known thread address,
// else the one order of theirs it names, else their one open thread; and
// an order it names must be that thread's. Anything less sure is unmatched.
export function matchShopifyReply(
	email: BuyerEmail,
	threads: ShopifyThreadRef[],
	orders: BuyerOrderRef[],
): ReplyMatch {
	if (!email.senderAuthenticated)
		return { threadId: null, why: "its sender isn't verified" };
	const sender = email.fromAddress.trim().toLowerCase();
	const theirs = threads.filter(
		(t) => t.email === sender && t.createdAt <= email.receivedAt,
	);
	if (theirs.length === 0) return { threadId: null, why: "not a buyer's" };

	// Each thread address by its token, against every thread: one no
	// thread has was made up or mistyped.
	const tokens = email.recipients
		.map(readThreadAddress)
		.flatMap((r) => (r.kind === "token" ? [r.token] : []));
	const found = tokens.flatMap((token) =>
		threads.filter((t) => t.replyToken === token).map((t) => t.id),
	);
	if (found.length < tokens.length)
		return {
			threadId: null,
			why: "it's sent to a thread address we didn't give",
		};
	const named = [...new Set(found)];
	if (named.length > 1)
		return { threadId: null, why: "it's sent to more than one thread" };
	const addressed = named[0];
	if (addressed !== undefined && !theirs.some((t) => t.id === addressed))
		return { threadId: null, why: "its thread address isn't this buyer's" };

	const ref = reference(email, theirs, orders, sender);
	if (ref.kind !== "none" && ref.kind !== "thread")
		return { threadId: null, why: ref.why };
	if (addressed !== undefined)
		return ref.kind === "thread" && ref.threadId !== addressed
			? { threadId: null, why: "it names another order than its thread's" }
			: { threadId: addressed, by: "address" };
	if (ref.kind === "thread") return { threadId: ref.threadId, by: "order" };
	const open = theirs.filter((t) => t.open);
	if (open.length === 1) return { threadId: open[0].id, by: "sender" };
	return {
		threadId: null,
		why: open.length > 1 ? "they have more than one open thread" : "no thread",
	};
}
