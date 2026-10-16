import { useMemo, useSyncExternalStore } from "react";
import { toast } from "sonner";

// The optimism engine: a change shows on screen the moment it's made, and the
// server catches up behind it.
//
// Every change goes through one queue, so the server sees changes in the
// order they were made, and an undo always lands after what it undoes. While
// a change waits or is being sent, its patch is laid over the page's data.
// Once the queue is empty the page reloads once, and the patches it now
// includes come off, so nothing flickers back to how it was. Nothing is sent
// while that reload runs, so a reload has every sent change and no other.
// A sent change's patch skips any data first seen after its reload started,
// since that data has it already; so a patch may safely add to a count
// (received + 5) as well as set a value, even in the moment the reloaded
// data shows before the engine lets go of the patch.
//
// A change that fails comes off the screen and says why in a toast.

// Changes the data of one kind of page; made by optimistic(...).patch, so a
// patch can only be laid over the data it was written for.
export type Patch = {
	readonly key: string;
	readonly apply: (data: never) => unknown;
};

type Change = {
	id: number;
	label: string | undefined;
	patches: readonly Patch[];
	send: () => Promise<unknown>;
	state: "waiting" | "sending" | "sent";
	// Reloads started before it was sent; data first seen after more had
	// started has it.
	sentAfter?: number;
	settle: (result: { value: unknown } | null) => void;
	// What the server answered, kept for an unpatched change until the reload
	// shows it.
	value?: unknown;
};

export type Result<T> = { value: T } | null;

export function createOptimism({
	reload,
	failed,
}: {
	reload: () => Promise<void>;
	// Says that a change, or the reload after it, didn't go through.
	failed: (message: string) => void;
}) {
	let changes: readonly Change[] = [];
	let pumping = false;
	let nextId = 0;
	// A change failed, so the page differs from what was shown; reload even if
	// nothing was sent.
	let stale = false;
	let reloadsStarted = 0;
	// When each piece of data was first seen, counted in reloads started.
	const seen = new WeakMap<object, number>();
	const listeners = new Set<() => void>();

	const set = (next: readonly Change[]) => {
		changes = next;
		for (const l of listeners) l();
	};
	const mark = (id: number, state: Change["state"], value?: unknown) =>
		set(
			changes.map((c) =>
				c.id === id ? { ...c, state, value, sentAfter: reloadsStarted } : c,
			),
		);
	// An unpatched change shows nothing until the reload, so it settles then,
	// and whoever waits on it sees it done; a patched one settles once sent.
	const settleShown = (sent: readonly Change[]) => {
		for (const c of sent)
			if (c.patches.length === 0) c.settle({ value: c.value });
	};

	async function pump() {
		if (pumping) return;
		pumping = true;
		try {
			for (;;) {
				const next = changes.find((c) => c.state === "waiting");
				if (next) {
					mark(next.id, "sending");
					try {
						const value = await next.send();
						mark(next.id, "sent", value);
						if (next.patches.length > 0) next.settle({ value });
					} catch (err) {
						set(changes.filter((c) => c.id !== next.id));
						stale = true;
						const message = err instanceof Error ? err.message : String(err);
						failed(
							next.label ? `${next.label} didn't save: ${message}` : message,
						);
						next.settle(null);
					}
					continue;
				}
				const sent = changes.filter((c) => c.state === "sent");
				if (sent.length === 0 && !stale) return;
				try {
					reloadsStarted++;
					await reload();
				} catch (err) {
					// The patches stay, so the page still shows what was saved.
					failed(
						`Saved, but the page couldn't refresh: ${err instanceof Error ? err.message : String(err)}`,
					);
					settleShown(sent);
					set(
						changes.filter(
							(c) => !(sent.includes(c) && c.patches.length === 0),
						),
					);
					return;
				}
				stale = false;
				set(changes.filter((c) => !sent.includes(c)));
				settleShown(sent);
			}
		} finally {
			pumping = false;
			// A change made while the last reload failed still needs sending.
			if (changes.some((c) => c.state === "waiting")) void pump();
		}
	}

	return {
		// Makes a change: its patch shows now, and it resolves to the server's
		// answer once sent, or to null once it has failed and said why. Without
		// a patch, nothing changes on screen until the reload after it, so it
		// resolves once that reload is in.
		change<T>({
			label,
			patch,
			send,
		}: {
			send: () => Promise<T>;
		} & (
			| {
					// What the change is, as in "Cost of ABC-1 didn't save". A
					// patched change says it, since staff have moved on by the time
					// it fails.
					label: string;
					patch: Patch | readonly Patch[];
			  }
			// Staff wait for an unpatched change, so its error alone says enough.
			| { label?: undefined; patch?: undefined }
		)): Promise<Result<T>> {
			return new Promise((resolve) => {
				set([
					...changes,
					{
						id: nextId++,
						label,
						patches: patch === undefined ? [] : [patch].flat(),
						send,
						state: "waiting",
						settle: resolve as Change["settle"],
					},
				]);
				void pump();
			});
		},
		// The data with every patch it doesn't have yet laid over, in order.
		// Data is first seen when it renders, and a page renders its data
		// before anyone can change it.
		over<T>(key: string, base: T): T {
			let loadedAfter = reloadsStarted;
			if (typeof base === "object" && base !== null) {
				const first = seen.get(base);
				if (first === undefined) seen.set(base, reloadsStarted);
				else loadedAfter = first;
			}
			let data = base;
			for (const c of changes) {
				if (c.state === "sent" && loadedAfter > (c.sentAfter ?? 0)) continue;
				for (const p of c.patches)
					if (p.key === key) data = (p.apply as (d: T) => T)(data);
			}
			return data;
		},
		// True while some change hasn't reached the server.
		saving: () => changes.some((c) => c.state !== "sent"),
		snapshot: () => changes,
		subscribe(listener: () => void) {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
	};
}

export type Optimism = ReturnType<typeof createOptimism>;

// The app's engine. Reloads the router's data once connected; until then a
// reload does nothing, which only happens on the server, where nothing
// changes.
let reloadPage: () => Promise<void> = () => Promise.resolve();

export const optimism = createOptimism({
	reload: () => reloadPage(),
	failed: (message) => toast.error(message),
});

export function connectOptimism(reload: () => Promise<void>) {
	reloadPage = reload;
}

// The same empty list each time, as React requires of a snapshot.
const none: readonly Change[] = [];
const server = () => none;

// Patches for one kind of page's data, and the hook that lays them over it.
// `name` keeps one kind's patches off another's; `id` keeps one record's off
// another record's of the same kind.
export function optimistic<T>(name: string) {
	const key = (id: string | number) => `${name}:${id}`;
	return {
		patch: (id: string | number, apply: (data: T) => T): Patch => ({
			key: key(id),
			apply: apply as (data: never) => unknown,
		}),
		useData(id: string | number, base: T): T {
			const changes = useSyncExternalStore(
				optimism.subscribe,
				optimism.snapshot,
				server,
			);
			// biome-ignore lint/correctness/useExhaustiveDependencies: changes is what over() reads
			return useMemo(() => optimism.over(key(id), base), [changes, id, base]);
		},
	};
}

// True while a change hasn't reached the server.
export function useSaving() {
	return useSyncExternalStore(optimism.subscribe, optimism.saving, () => false);
}

// Leaving the page would drop changes that haven't been sent, so the browser
// asks first. Swapped rather than added on hot reload.
if (typeof window !== "undefined") {
	const w = window as { optimismUnload?: (e: BeforeUnloadEvent) => void };
	if (w.optimismUnload)
		window.removeEventListener("beforeunload", w.optimismUnload);
	w.optimismUnload = (e) => {
		if (optimism.saving()) e.preventDefault();
	};
	window.addEventListener("beforeunload", w.optimismUnload);
}
