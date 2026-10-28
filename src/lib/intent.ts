import { useMemo, useSyncExternalStore } from "react";

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
		async run<Result>(
			capture: () => Payload,
			send: (payload: Payload) => Promise<Result | null>,
		): Promise<Result | null> {
			if (state.kind === "pending" || state.kind === "checking") return null;
			const payload =
				state.kind === "retry" ? state.payload : structuredClone(capture());
			change({ kind: "pending", payload });
			try {
				const result = await send(payload);
				change(result === null ? { kind: "retry", payload } : { kind: "idle" });
				return result;
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
