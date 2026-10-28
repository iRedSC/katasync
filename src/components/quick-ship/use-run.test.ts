import { describe, expect, it } from "vitest";
import { createRunner } from "./use-run";

function deferred<T>() {
	let resolve!: (v: T) => void;
	const promise = new Promise<T>((res) => {
		resolve = res;
	});
	return { promise, resolve };
}

function setup() {
	const seen = { busy: false, error: null as string | null };
	const runner = createRunner({
		setBusy: (b) => {
			seen.busy = b;
		},
		setError: (e) => {
			seen.error = e;
		},
	});
	return { seen, ...runner };
}

describe("quick ship's runner", () => {
	it("stays busy until the last piece of work answers, not the first", async () => {
		const { seen, run } = setup();
		const slow = deferred<string>();
		const fast = deferred<string>();
		const a = run(() => slow.promise);
		const b = run(() => fast.promise);
		fast.resolve("prices");
		expect(await b).toBe("prices");
		expect(seen.busy).toBe(true);
		slow.resolve("plan");
		expect(await a).toBe("plan");
		expect(seen.busy).toBe(false);
	});

	it("drops work that answers after its opening ended", async () => {
		const { seen, run, end } = setup();
		const old = deferred<string>();
		const late = run(() => old.promise);
		end();
		const fresh = deferred<string>();
		const now = run(() => fresh.promise);
		old.resolve("for the last order");
		expect(await late).toBeUndefined();
		// The new opening's work still holds it busy.
		expect(seen.busy).toBe(true);
		fresh.resolve("ok");
		await now;
		expect(seen.busy).toBe(false);
	});

	it("says why work failed", async () => {
		const { seen, run } = setup();
		expect(await run(() => Promise.reject(new Error("No rates")))).toBe(
			undefined,
		);
		expect(seen.error).toBe("No rates");
		expect(seen.busy).toBe(false);
	});
});
