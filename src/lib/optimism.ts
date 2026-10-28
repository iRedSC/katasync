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
// A sent change's patch skips any data whose load started after the server
// answered it (the engine's reload, or a page loading or preloading as staff
// move around), since that data has it already; so a patch may safely add to
// a count (received + 5) as well as set a value, even in the moment the
// reloaded data shows before the engine lets go of the patch. Data whose load
// finished before the change was sent still gets it, however late it first
// shows, as when a page preloaded on hover opens after the change. A load
// that ran while the change was sending may or may not have it: the patch
// stays over it as it was before the answer, and the engine reloads rather
// than let that guess stand once its own reload has failed.
//
// A change made as another change starts sending (a helper that makes its
// own change, called from a send) goes to the server at once, as part of it,
// rather than waiting behind the change that's waiting for it.
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
	// On the engine's clock: when it began sending, and when the server
	// answered. Data loaded wholly before `sendingAt` lacks it; data whose
	// load started after `sentAt` has it; any other may have it or not.
	sendingAt?: number;
	sentAt?: number;
	// A reload was asked for because data of unknown freshness showed while
	// it was sent; asked once, so a server that stays down isn't hammered.
	rechecked?: true;
	settle: (result: { value: unknown } | null) => void;
	// What the server answered, kept for an unpatched change until the reload
	// shows it.
	value?: unknown;
};

export type Result<T> = { value: T } | null;

// When a load ran, on the engine's clock.
type Loaded = { started: number; finished: number };

// Whether loaded data has a sent change. A load that overlapped the send may
// have read the database before the change committed or after, and nothing
// here can tell which.
function includes(loaded: Loaded, c: Change): "yes" | "no" | "unknown" {
	if (loaded.started > (c.sentAt ?? Infinity)) return "yes";
	if (loaded.finished < (c.sendingAt ?? -Infinity)) return "no";
	return "unknown";
}

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
	// Ticks at every load start and end, send start, and answer, so they can
	// be ordered against each other.
	let clock = 0;
	let lastLoadStart = 0;
	// True while a send is being started, so a change it makes joins it.
	let starting = false;
	// When each piece of data was loaded, on the clock.
	const seen = new WeakMap<object, Loaded>();
	// Marks data, and every object and list within it, as from one load. Data
	// seen before keeps its mark, as a load may hand back data it kept from an
	// earlier one.
	const stamp = (data: unknown, loaded: Loaded) => {
		if (typeof data !== "object" || data === null || seen.has(data)) return;
		const proto = Object.getPrototypeOf(data);
		if (!Array.isArray(data) && proto !== Object.prototype && proto !== null)
			return;
		seen.set(data, loaded);
		for (const v of Object.values(data)) stamp(v, loaded);
	};
	const listeners = new Set<() => void>();

	const set = (next: readonly Change[]) => {
		changes = next;
		for (const l of listeners) l();
	};
	const mark = (id: number, state: Change["state"], value?: unknown) => {
		const at = ++clock;
		set(
			changes.map((c) =>
				c.id !== id
					? c
					: state === "sent"
						? { ...c, state, value, sentAt: at }
						: { ...c, state, sendingAt: at },
			),
		);
	};
	// Data that may or may not have a sent change showed after the engine's
	// reload failed; reload once more so the guess doesn't stand.
	const recheck = (c: Change) => {
		if (c.rechecked) return;
		c.rechecked = true;
		queueMicrotask(() => void pump());
	};
	// An unpatched change shows nothing until the reload, so it settles then,
	// and whoever waits on it sees it done; a patched one settles once sent.
	const settleShown = (sent: readonly Change[]) => {
		for (const c of sent)
			if (c.patches.length === 0) c.settle({ value: c.value });
	};

	// Sends one change. Resolves to its answer, or to null once it has failed,
	// been taken off, and said why.
	async function deliver(c: Change): Promise<{ value: unknown } | null> {
		try {
			const was = starting;
			starting = true;
			let pending: Promise<unknown>;
			try {
				pending = c.send();
			} finally {
				starting = was;
			}
			const value = await pending;
			mark(c.id, "sent", value);
			return { value };
		} catch (err) {
			set(changes.filter((x) => x.id !== c.id));
			stale = true;
			const message = err instanceof Error ? err.message : String(err);
			failed(c.label ? `${c.label} didn't save: ${message}` : message);
			c.settle(null);
			return null;
		}
	}

	async function pump() {
		if (pumping) return;
		pumping = true;
		try {
			for (;;) {
				const next = changes.find((c) => c.state === "waiting");
				if (next) {
					mark(next.id, "sending");
					const r = await deliver(next);
					if (r && next.patches.length > 0) next.settle(r);
					continue;
				}
				const sent = changes.filter((c) => c.state === "sent");
				if (sent.length === 0 && !stale) return;
				try {
					lastLoadStart = ++clock;
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
		// resolves once that reload is in. One made as a send starts goes out
		// at once, as part of that send, and resolves once it's sent. A send must
		// not make a change after it has awaited something: that change would
		// wait behind the send waiting for it.
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
				const c: Change = {
					id: nextId++,
					label,
					patches: patch === undefined ? [] : [patch].flat(),
					send,
					state: starting ? "sending" : "waiting",
					sendingAt: starting ? ++clock : undefined,
					settle: resolve as Change["settle"],
				};
				if (!starting) {
					set([...changes, c]);
					void pump();
					return;
				}
				// Ahead of what's waiting, so its patch lays over in the order made.
				const at = changes.findIndex((x) => x.state === "waiting");
				set(
					at === -1
						? [...changes, c]
						: [...changes.slice(0, at), c, ...changes.slice(at)],
				);
				void deliver(c).then((r) => r && c.settle(r));
			});
		},
		// The data with every patch it doesn't have yet laid over, in order.
		// Data that didn't come through load(), such as a list put together on
		// the page, counts as from the latest load to start before it first
		// rendered, and a page renders its data before anyone can change it.
		over<T>(key: string, base: T): T {
			let loaded: Loaded = { started: lastLoadStart, finished: clock };
			if (typeof base === "object" && base !== null) {
				const first = seen.get(base);
				if (first === undefined) seen.set(base, loaded);
				else loaded = first;
			}
			let data = base;
			for (const c of changes) {
				if (!c.patches.some((p) => p.key === key)) continue;
				if (c.state === "sent") {
					const has = includes(loaded, c);
					if (has === "yes") continue;
					if (has === "unknown" && !pumping) recheck(c);
				}
				for (const p of c.patches)
					if (p.key === key) data = (p.apply as (d: T) => T)(data);
			}
			return data;
		},
		// Loads data, as a page's loader does, marking it with when the load
		// started and finished: it has every change the server answered before
		// it started, and none sent after it finished, however late it shows.
		async load<T>(fetch: () => T | Promise<T>): Promise<T> {
			const started = ++clock;
			lastLoadStart = started;
			const data = await fetch();
			stamp(data, { started, finished: ++clock });
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

// Ids for things a change makes, such as a PO line, before the server has
// made them. One made here is negative until the change that makes it is
// answered and passes the server's id to `confirm`; the page shows the
// server's after the reload. Changes are sent in order, so by the time a
// later change sends, the one that made its id has been answered.
let provisionals = 0;
const confirmed = new Map<number, number>();

export const ids = {
	// A new id for something not made yet.
	provisional() {
		provisionals++;
		return -provisionals;
	},
	// The server made it, as `real`.
	confirm(provisional: number, real: number) {
		confirmed.set(provisional, real);
	},
	// The server's id, when it's known; else the one made here.
	current: (id: number) => confirmed.get(id) ?? id,
	// The id to send. Throws when what it names was never made, because the
	// change that made it failed, so nothing sends an id the server never gave.
	server(id: number) {
		if (id > 0) return id;
		const real = confirmed.get(id);
		if (real === undefined) throw new Error("An earlier change didn't save");
		return real;
	},
	// Whether two ids name the same thing: either may be the one made here or
	// the server's. Patches match with this, as they may lay over data from
	// before the reload or after it.
	same: (a: number, b: number) => ids.current(a) === ids.current(b),
};

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
