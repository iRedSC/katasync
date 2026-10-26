import { Refused, Unsure, unsureStatus } from "./states";

// Hands an email to Resend, for the buyers we answer by email (Amazon's
// relay, Shopify's own). The request key makes a retry the same send, so
// one unsure attempt can be tried again without the buyer getting two.
// Resend's email ID back; throws Unsure when it may yet have gone.
export async function sendWithResend(r: {
	from: string;
	replyTo?: string;
	to: string;
	subject: string;
	inReplyTo: string | null;
	text: string;
	requestKey: string;
	attachments?: { filename: string; content: string }[];
}) {
	const key = process.env.RESEND_API_KEY;
	if (!key) throw new Refused("Emails aren't set up: add RESEND_API_KEY");
	let res: Response;
	let body: { id?: string; message?: string; name?: string } | null;
	try {
		res = await fetch("https://api.resend.com/emails", {
			method: "POST",
			headers: {
				Authorization: `Bearer ${key}`,
				"Content-Type": "application/json",
				"Idempotency-Key": r.requestKey,
			},
			body: JSON.stringify({
				from: r.from,
				to: [r.to],
				subject: r.subject,
				text: r.text,
				...(r.replyTo ? { reply_to: r.replyTo } : {}),
				...(r.attachments?.length ? { attachments: r.attachments } : {}),
				...(r.inReplyTo
					? { headers: { "In-Reply-To": r.inReplyTo, References: r.inReplyTo } }
					: {}),
			}),
		});
		body = await res.json().catch(() => null);
	} catch (error) {
		throw new Unsure(error instanceof Error ? error.message : String(error));
	}
	if (res.ok && body?.id) return body.id;
	const why = `Resend answered ${res.status}: ${body?.message ?? res.statusText}`;
	// Taken without an ID to show, or not answered plainly: it may have gone.
	throw res.ok || unsureStatus(res.status) ? new Unsure(why) : new Refused(why);
}

// Resend's events (resend.com/docs/dashboard/emails/introduction): which
// mean the buyer's mail server (or Amazon's) has it, which mean it never got there, and which are
// still on the way. One not listed is reported rather than guessed at.
const ARRIVED = ["delivered", "opened", "clicked", "complained"];
const NEVER = ["bounced", "failed", "suppressed", "canceled"];
const GOING = ["queued", "scheduled", "sent", "delivery_delayed"];

// What Resend last heard of an email we sent.
export async function resendStatus(resendId: string) {
	const res = await fetch(
		`https://api.resend.com/emails/${encodeURIComponent(resendId)}`,
		{ headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}` } },
	);
	if (!res.ok)
		throw new Error(`Resend answered ${res.status}: ${await res.text()}`);
	const { last_event: last = "" } = (await res.json()) as {
		last_event?: string;
	};
	if (ARRIVED.includes(last)) return { state: "delivered" as const };
	if (NEVER.includes(last))
		return { state: "failed" as const, error: `Resend says it ${last}` };
	if (GOING.includes(last)) return { state: "going" as const };
	throw new Error(`Resend says ${last || "nothing"} of reply ${resendId}`);
}
