import { useMemo, useSyncExternalStore } from "react";

type IntentState<Payload> =
	| { kind: "idle" }
	| { kind: "pending"; payload: Payload }
	| { kind: "retry"; payload: Payload };

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
		async run<Result>(
			capture: () => Payload,
			send: (payload: Payload) => Promise<Result | null>,
		): Promise<Result | null> {
			if (state.kind === "pending") return null;
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
	return { state, run: intent.run, getSnapshot: intent.getSnapshot };
}
