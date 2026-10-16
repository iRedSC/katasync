import { describe, expect, it, vi } from "vitest";
import { createOptimism, type Patch } from "./optimism";

vi.mock("sonner", () => ({ toast: { error: () => {} } }));

function deferred<T = void>() {
	let resolve!: (v: T) => void;
	let reject!: (e: unknown) => void;
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

type Count = { n: number };
const add = (by: number): Patch => ({
	key: "count:1",
	apply: ((d: Count) => ({ n: d.n + by })) as (d: never) => unknown,
});

// A server holding a count, and an engine whose reloads read it.
function setup() {
	const server = { n: 0 };
	let page: Count = { n: 0 };
	const reloads: ReturnType<typeof deferred<void>>[] = [];
	const failures: string[] = [];
	// What showed when the reloaded data first rendered, before the engine
	// let go of the patches it includes.
	const committed: Count[] = [];
	const engine = createOptimism({
		reload: async () => {
			const d = deferred();
			reloads.push(d);
			await d.promise;
			page = { ...server };
			committed.push(engine.over("count:1", page));
		},
		failed: (m) => failures.push(m),
	});
	const shown = () => engine.over("count:1", page);
	// The page is on screen before anyone changes it.
	shown();
	return { server, engine, reloads, failures, shown, committed };
}

describe("optimism", () => {
	it("shows a change before the server answers", async () => {
		const { engine, shown } = setup();
		const sent = deferred();
		engine.change({ label: "Add", patch: add(5), send: () => sent.promise });
		expect(shown()).toEqual({ n: 5 });
		expect(engine.saving()).toBe(true);
	});

	it("sends changes one at a time, in the order they were made", async () => {
		const { engine } = setup();
		const order: string[] = [];
		const first = deferred();
		engine.change({
			send: async () => {
				order.push("a start");
				await first.promise;
				order.push("a end");
			},
		});
		engine.change({
			send: async () => {
				order.push("b start");
			},
		});
		await tick();
		expect(order).toEqual(["a start"]);
		first.resolve();
		await tick();
		expect(order).toEqual(["a start", "a end", "b start"]);
	});

	it("keeps a patch until the reload that includes it, so nothing flickers back", async () => {
		const { server, engine, reloads, shown } = setup();
		const done = engine.change({
			label: "Add",
			patch: add(5),
			send: async () => {
				server.n += 5;
			},
		});
		expect(await done).toEqual({ value: undefined });
		// Sent, but the page hasn't reloaded yet.
		expect(shown()).toEqual({ n: 5 });
		expect(engine.saving()).toBe(false);
		reloads[0].resolve();
		await tick();
		expect(shown()).toEqual({ n: 5 });
		expect(engine.snapshot()).toHaveLength(0);
	});

	it("never adds a count twice when the reloaded data shows before the patch comes off", async () => {
		const { server, engine, reloads, shown, committed } = setup();
		await engine.change({
			label: "Add",
			patch: add(5),
			send: async () => {
				server.n += 5;
			},
		});
		reloads[0].resolve();
		await tick();
		expect(committed).toEqual([{ n: 5 }]);
		expect(shown()).toEqual({ n: 5 });
	});

	it("sends nothing while a reload runs, so an added count never doubles", async () => {
		const { server, engine, reloads, shown, committed } = setup();
		const send = vi.fn(async () => {
			server.n += 5;
		});
		await engine.change({ label: "Add", patch: add(5), send });
		expect(reloads).toHaveLength(1);
		engine.change({ label: "Add", patch: add(5), send });
		await tick();
		expect(send).toHaveBeenCalledTimes(1);
		expect(shown()).toEqual({ n: 10 });
		reloads[0].resolve();
		await tick();
		expect(send).toHaveBeenCalledTimes(2);
		expect(shown()).toEqual({ n: 10 });
		reloads[1].resolve();
		await tick();
		expect(committed).toEqual([{ n: 10 }, { n: 10 }]);
		expect(shown()).toEqual({ n: 10 });
		expect(server.n).toBe(10);
	});

	it("reloads once for a burst of changes", async () => {
		const { engine, reloads } = setup();
		const a = engine.change({
			label: "A",
			patch: add(1),
			send: async () => {},
		});
		const b = engine.change({
			label: "B",
			patch: add(1),
			send: async () => {},
		});
		await Promise.all([a, b]);
		await tick();
		expect(reloads).toHaveLength(1);
	});

	it("resolves an unpatched change once the reload shows it", async () => {
		const { engine, reloads } = setup();
		let done = false;
		engine.change({ send: async () => 7 }).then((r) => {
			expect(r).toEqual({ value: 7 });
			done = true;
		});
		await tick();
		expect(reloads).toHaveLength(1);
		expect(done).toBe(false);
		reloads[0].resolve();
		await tick();
		expect(done).toBe(true);
	});

	it("still resolves an unpatched change when the reload fails", async () => {
		const { engine, reloads } = setup();
		const r = engine.change({ send: async () => 7 });
		await tick();
		reloads[0].reject(new Error("offline"));
		expect(await r).toEqual({ value: 7 });
		expect(engine.snapshot()).toHaveLength(0);
	});

	it("takes a failed change off the screen and says why", async () => {
		const { engine, reloads, failures, shown } = setup();
		const r = await engine.change({
			label: "Cost of ABC-1",
			patch: add(5),
			send: () => Promise.reject(new Error("PO is closed")),
		});
		expect(r).toBeNull();
		expect(shown()).toEqual({ n: 0 });
		expect(failures).toEqual(["Cost of ABC-1 didn't save: PO is closed"]);
		// Reloads anyway, since the page may have moved on without it.
		await tick();
		expect(reloads).toHaveLength(1);
	});

	it("keeps a later change when an earlier one fails", async () => {
		const { engine, shown } = setup();
		engine.change({
			label: "A",
			patch: add(1),
			send: () => Promise.reject(new Error("no")),
		});
		const b = deferred();
		engine.change({ label: "B", patch: add(10), send: () => b.promise });
		await tick();
		expect(shown()).toEqual({ n: 10 });
	});

	it("keeps patches when the reload fails, and says so", async () => {
		const { engine, reloads, failures, shown } = setup();
		await engine.change({ label: "Add", patch: add(5), send: async () => {} });
		reloads[0].reject(new Error("offline"));
		await tick();
		expect(shown()).toEqual({ n: 5 });
		expect(failures[0]).toMatch(/couldn't refresh: offline/);
	});

	it("sends a change made as another starts with it, rather than deadlocking", async () => {
		const { engine } = setup();
		const order: string[] = [];
		const outer = engine.change({
			label: "Outer",
			patch: add(1),
			send: async () => {
				const inner = await engine.change({
					label: "Inner",
					patch: add(10),
					send: async () => {
						order.push("inner");
						return "in";
					},
				});
				order.push("outer");
				return inner;
			},
		});
		expect(await outer).toEqual({ value: { value: "in" } });
		expect(order).toEqual(["inner", "outer"]);
	});

	it("never adds a sent change twice to data a page loaded by itself", async () => {
		const { server, engine, shown } = setup();
		const later = deferred();
		await engine.change({
			label: "Add",
			patch: add(5),
			send: async () => {
				server.n += 5;
			},
		});
		// Still busy, so the engine hasn't reloaded yet.
		engine.change({ label: "Wait", patch: add(0), send: () => later.promise });
		expect(shown()).toEqual({ n: 5 });
		// Staff go elsewhere and back: the page loads what the server has.
		engine.loadStarted();
		const fresh = { ...server };
		expect(engine.over("count:1", fresh)).toEqual({ n: 5 });
	});

	it("lays patches only over the data they were written for", () => {
		const { engine } = setup();
		engine.change({
			label: "Add",
			patch: add(5),
			send: () => deferred().promise,
		});
		expect(engine.over("count:2", { n: 0 })).toEqual({ n: 0 });
	});
});
