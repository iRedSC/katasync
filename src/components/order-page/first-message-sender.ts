import type { FirstMessage } from "#/buyers/chat-way";

// The order page's tries at a first eBay message, one at a time. Each try
// has its own key, kept until the server says how it went: a second press
// while one is out does nothing, and asking again after a lost answer uses
// the same key, so the server reads that try back instead of sending again
// (first-message.ts). Once a try is settled, the next send is a new one.

// lost: the answer never came back, so it may or may not have gone.
export type Attempt = FirstMessage | { kind: "lost"; reason: string };

export function firstMessageSender(
	send: (text: string, requestKey: string) => Promise<FirstMessage>,
	newKey: () => string = () => crypto.randomUUID(),
) {
	let key: string | null = null;
	let busy = false;
	return {
		// A try is out, or its outcome isn't known: its words are fixed.
		get open() {
			return busy || key !== null;
		},
		// Null when a try is already out.
		async send(text: string): Promise<Attempt | null> {
			if (busy) return null;
			busy = true;
			key ??= newKey();
			try {
				const r = await send(text, key);
				if (r.kind !== "sending") key = null;
				return r;
			} catch (error) {
				return {
					kind: "lost",
					reason: `No answer from katasync (${error instanceof Error ? error.message : String(error)})`,
				};
			} finally {
				busy = false;
			}
		},
	};
}
