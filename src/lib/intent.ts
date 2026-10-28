import { useMemo, useSyncExternalStore } from "react";
import type { Answer } from "./answer";
import type { Result } from "./optimism";

// How a send ended. Saved and rejected are both final: a rejection saved
// nothing, so what's sent next is captured afresh from what staff fix. Only
// uncertain (the answer never came, so it may have saved) sends the same
// payload again.
export type Outcome<R> =
	| { kind: "saved"; value: R }
	| { kind: "rejected"; problem: string }
	| { kind: "uncertain" };

// A change sent through the optimism engine to a server function that
// answers refusals: null is a send that threw, so its fate is unknown.
export const answered = <T>(result: Result<Answer<T>>): Outcome<T> =>
	result === null
		? { kind: "uncertain" }
		: result.value.ok
			? { kind: "saved", value: result.value.value }
			: { kind: "rejected", problem: result.value.problem };

type IntentState<Payload> =
	| { kind: "idle" }
	| { kind: "pending"; payload: Payload }
	| { kind: "retry"; payload: Payload }
	// Asking the server whether a retry's payload was recorded.
	| { kind: "checking"; payload: Payload };

// How a retry ended, as the server tells it: it was recorded, or it wasn't,
// or the server couldn't be asked.
export type Recorded = boolean | null;

export function createIntent<Payload>() {
	let state: IntentState<Payload> = { kind: "idle" };
	const listeners = new Set<() => void>();
	const change = (next: IntentState<Payload>) => {
		state = next;
		for (const listener of listeners) listener();
	};
	return {
		getSnapshot: () => state,
		subscribe: (listener: () => void) => {
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		},
		// Lets go of a retry once the server says whether its payload was
		// recorded, so new details are never sent beside one that may have
		// landed. While it can't tell, the retry stays, and resending it is
		// still safe. A send in flight stays either way.
		async release(check: (payload: Payload) => Promise<Recorded>) {
			if (state.kind !== "retry") return null;
			const { payload } = state;
			change({ kind: "checking", payload });
			let recorded: Recorded = null;
			try {
				recorded = await check(payload);
			} finally {
				change(
					recorded === null ? { kind: "retry", payload } : { kind: "idle" },
				);
			}
			return recorded;
		},
		// Busy when one is already being sent or checked, and nothing is sent.
		async run<Result>(
			capture: () => Payload,
			send: (payload: Payload) => Promise<Outcome<Result>>,
		): Promise<Outcome<Result> | { kind: "busy" }> {
			if (state.kind === "pending" || state.kind === "checking")
				return { kind: "busy" };
			const payload =
				state.kind === "retry" ? state.payload : structuredClone(capture());
			change({ kind: "pending", payload });
			try {
				const outcome = await send(payload);
				change(
					outcome.kind === "uncertain"
						? { kind: "retry", payload }
						: { kind: "idle" },
				);
				return outcome;
			} catch (error) {
				change({ kind: "retry", payload });
				throw error;
			}
		},
	};
}

export function useIntent<Payload>() {
	const intent = useMemo(() => createIntent<Payload>(), []);
	const state = useSyncExternalStore(
		intent.subscribe,
		intent.getSnapshot,
		intent.getSnapshot,
	);
	return {
		state,
		run: intent.run,
		release: intent.release,
		getSnapshot: intent.getSnapshot,
	};
}
