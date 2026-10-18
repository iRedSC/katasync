// Emails a PO through Resend (https://resend.com/docs/api-reference/emails).
//
//   RESEND_API_KEY     an API key with sending access
//   PO_EMAIL_FROM      a sender on a domain verified in Resend, e.g.
//                      "East Coast Drywall Tools <purchasing@ecdrywalltools.com>"
//   PO_EMAIL_REPLY_TO  where supplier replies go; also gets a copy (Bcc) of
//                      every PO, since Resend keeps no Sent folder

export class EmailNotConfiguredError extends Error {
	name = "EmailNotConfiguredError";
}

export function emailConfigured() {
	return Boolean(process.env.RESEND_API_KEY && process.env.PO_EMAIL_FROM);
}

export async function sendEmail(message: {
	to: string;
	subject: string;
	text: string;
	attachments: { filename: string; content: Buffer }[];
}) {
	const key = process.env.RESEND_API_KEY;
	const from = process.env.PO_EMAIL_FROM;
	if (!key || !from)
		throw new EmailNotConfiguredError(
			"Email isn't set up: add RESEND_API_KEY and PO_EMAIL_FROM",
		);
	const replyTo = process.env.PO_EMAIL_REPLY_TO;
	const res = await fetch("https://api.resend.com/emails", {
		method: "POST",
		headers: {
			Authorization: `Bearer ${key}`,
			"Content-Type": "application/json",
		},
		body: JSON.stringify({
			from,
			to: [message.to],
			...(replyTo ? { reply_to: replyTo, bcc: [replyTo] } : {}),
			subject: message.subject,
			text: message.text,
			attachments: message.attachments.map((a) => ({
				filename: a.filename,
				content: a.content.toString("base64"),
			})),
		}),
	});
	if (!res.ok) {
		const body = (await res.json().catch(() => null)) as {
			message?: string;
		} | null;
		throw new Error(
			`Email to ${message.to} failed: ${body?.message ?? res.statusText}`,
		);
	}
}
