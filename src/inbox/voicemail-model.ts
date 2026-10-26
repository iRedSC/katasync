import { z } from "zod";

export const voicemailDecision = z.discriminatedUnion("state", [
	z.object({
		state: z.literal("ready"),
		title: z.string().trim().min(1).max(160),
		summary: z.string().trim().min(1).max(4000),
		level: z.enum(["normal", "important", "critical"]),
		orderIds: z.array(z.number().int().positive()).max(6),
		productIds: z.array(z.number().int().positive()).max(6),
	}),
	z.object({
		state: z.literal("dismissed"),
		reason: z.string().trim().min(1).max(500),
	}),
	z.object({
		state: z.literal("review"),
		reason: z.string().trim().min(1).max(500),
	}),
]);

export const voicemailState = z.union([
	voicemailDecision,
	z.object({ state: z.literal("pending") }),
	z.object({
		state: z.literal("processing"),
		token: z.string().uuid(),
		startedAt: z.string().datetime(),
	}),
]);

export type VoicemailState = z.infer<typeof voicemailState>;
export type VoicemailDecision = z.infer<typeof voicemailDecision>;

export function isVoicemail(email: {
	fromAddress: string;
	subject: string;
	body?: string;
}) {
	if (!/\bnew voicemail\b/i.test(email.subject)) return false;
	if (email.fromAddress.trim().toLowerCase() === "no_reply@ooma.com")
		return true;
	return (
		/^(?:fw|fwd):/i.test(email.subject.trim()) &&
		/^\s*From:\s*(?:[^\n]*<no_reply@ooma\.com>|no_reply@ooma\.com)(?:\s|$)/im.test(
			email.body ?? "",
		)
	);
}

export function voicemailContent(body: string) {
	const text = body.replace(/\r\n?/g, "\n").replace(/\u00a0/g, " ");
	const field = (label: string) => {
		const value = new RegExp(
			`(?:^|\\n)[ \\t]*${label}[ \\t]*:?[ \\t]*(?:\\n[ \\t]*)*([^\\n]+)`,
			"i",
		)
			.exec(text)?.[1]
			?.trim();
		return value &&
			!/^(?:Caller Name|Caller Number|Duration|Voicemail Preview)\b/i.test(
				value,
			)
			? value
			: null;
	};
	const preview =
		/Voicemail Preview\s*:\s*([\s\S]*?)(?=\n\s*To listen to this voicemail\b|$)/i
			.exec(text)?.[1]
			?.trim() ?? "";
	return {
		callerName: field("Caller Name"),
		callerNumber: field("Caller Number"),
		duration: field("Duration"),
		transcript: preview,
	};
}

export function isMp3(file: { filename: string; contentType: string }) {
	return (
		/\.mp3$/i.test(file.filename) ||
		/^(?:audio\/(?:mpeg|mp3|x-mp3))$/i.test(file.contentType)
	);
}
