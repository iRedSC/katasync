import { useSyncExternalStore } from "react";
import type { ReplyStatus } from "#/buyers/states";
import { replyToBuyer } from "#/server/buyers";

// Replies on their way out of this browser, kept outside any one
// conversation so switching threads never drops one. Each is held a few
// seconds first, to undo, then sent under its key: trying again after a
// lost answer is the same reply, never a second. Leaving the page while one
// is held or sending asks first.

export const HOLD_MS = 10_000;

// held: waiting out the hold, not sent. unheard: sent, but the answer
// never came back, so it may or may not have gone.
export type OutStatus = "held" | "unheard" | ReplyStatus;

export type Outgoing = {
	key: string;
	threadId: number;
	body: string;
	at: Date;
	status: OutStatus;
	error: string | null;
	// When a held one goes.
	sendAt: number;
};

let items: Outgoing[] = [];
const listeners = new Set<() => void>();
const timers = new Map<string, ReturnType<typeof setTimeout>>();
// Words taken back by undo, for their conversation's reply box.
const returned = new Map<number, string>();
let refresh: () => Promise<unknown> = async () => {};

function emit() {
	for (const l of listeners) l();
}

function update(key: string, patch: Partial<Outgoing>) {
	items = items.map((o) => (o.key === key ? { ...o, ...patch } : o));
	emit();
}

const subscribe = (l: () => void) => {
	listeners.add(l);
	return () => listeners.delete(l);
};

export function useOutgoing() {
	return useSyncExternalStore(
		subscribe,
		() => items,
		() => items,
	);
}

// How the list catches up once a reply has gone (the router reloading).
export function setRefresh(fn: () => Promise<unknown>) {
	refresh = fn;
}

// Holds a reply, then sends it. False when that key is already out.
export function hold(o: { key: string; threadId: number; body: string }) {
	if (items.some((x) => x.key === o.key)) return false;
	const sendAt = Date.now() + HOLD_MS;
	items = [
		...items,
		{ ...o, at: new Date(), status: "held", error: null, sendAt },
	];
	timers.set(
		o.key,
		setTimeout(() => void deliver(o.key), HOLD_MS),
	);
	emit();
	return true;
}

// Sends a held one without waiting out the hold.
export function sendNow(key: string) {
	if (items.find((o) => o.key === key)?.status !== "held") return;
	void deliver(key);
}

// Takes a held one back, its words to its reply box. False once it's gone.
export function undo(key: string) {
	const o = items.find((x) => x.key === key);
	if (o?.status !== "held") return false;
	clearTimeout(timers.get(key));
	timers.delete(key);
	items = items.filter((x) => x.key !== key);
	returned.set(o.threadId, o.body);
	emit();
	return true;
}

// The words undo took back for a conversation, once.
export function takeReturned(threadId: number) {
	const words = returned.get(threadId);
	returned.delete(threadId);
	return words;
}

// Sends one whose answer never came, again under the same key.
export function retry(key: string) {
	if (items.find((o) => o.key === key)?.status !== "unheard") return;
	void deliver(key);
}

async function deliver(key: string) {
	clearTimeout(timers.get(key));
	timers.delete(key);
	const o = items.find((x) => x.key === key);
	if (!o || (o.status !== "held" && o.status !== "unheard")) return;
	update(key, { status: "sending", error: null });
	try {
		const r = await replyToBuyer({
			data: { threadId: o.threadId, text: o.body, requestKey: key },
		});
		update(key, { status: r.status ?? "sending" });
	} catch (error) {
		update(key, {
			status: "unheard",
			error: error instanceof Error ? error.message : String(error),
		});
	}
	// The list catching up is apart from whether it sent.
	await refresh().catch(() => {});
}

if (typeof window !== "undefined")
	window.addEventListener("beforeunload", (e) => {
		if (items.some((o) => o.status === "held" || o.status === "sending"))
			e.preventDefault();
	});
