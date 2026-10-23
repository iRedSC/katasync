import { beforeEach, describe, expect, it, vi } from "vitest";
import { lockOnOwnConnection } from "./dispatch";

// The order lock is a Postgres advisory lock held by another connection,
// which PGlite's single session can't show; the other tests use memoryLocker.
// So this runs against a real server: CI starts one (.github/workflows/
// test.yml), and locally it runs when TEST_POSTGRES_URL is set.
const url = process.env.TEST_POSTGRES_URL;
if (process.env.CI && !url)
	throw new Error(
		"TEST_POSTGRES_URL is not set, so the order lock goes untested",
	);

// Order ids no real order has, in case it points at a database in use.
describe.skipIf(!url)("lockOnOwnConnection", () => {
	beforeEach(() => {
		vi.stubEnv("DATABASE_URL", url);
	});
	const locker = lockOnOwnConnection;

	// Holds the lock on orderIds until release() is called.
	function hold(orderIds: number[]) {
		let release = () => {};
		const gate = new Promise<void>((r) => {
			release = r;
		});
		let entered = () => {};
		const inside = new Promise<void>((r) => {
			entered = r;
		});
		const done = locker(orderIds, async () => {
			entered();
			await gate;
		});
		return { inside, release, done };
	}

	const settles = (p: Promise<unknown>, ms = 300) =>
		Promise.race([
			p.then(() => true),
			new Promise<boolean>((r) => setTimeout(() => r(false), ms)),
		]);

	it("makes a second buyer of the same order wait for the first", async () => {
		const first = hold([2_147_480_001]);
		await first.inside;
		const second = locker([2_147_480_001], async () => "second");
		expect(await settles(second)).toBe(false);
		first.release();
		await first.done;
		expect(await second).toBe("second");
	});

	it("waits when any order of a combined dispatch is held", async () => {
		const first = hold([2_147_480_002]);
		await first.inside;
		const combined = locker(
			[2_147_480_003, 2_147_480_002],
			async () => "combined",
		);
		expect(await settles(combined)).toBe(false);
		first.release();
		await first.done;
		expect(await combined).toBe("combined");
	});

	it("lets other orders through", async () => {
		const first = hold([2_147_480_004]);
		await first.inside;
		expect(
			await settles(
				locker([2_147_480_005], async () => {}),
				5000,
			),
		).toBe(true);
		first.release();
		await first.done;
	});

	it("lets go when the work fails", async () => {
		await expect(
			locker([2_147_480_006], async () => {
				throw new Error("label purchase failed");
			}),
		).rejects.toThrow("label purchase failed");
		expect(
			await settles(
				locker([2_147_480_006], async () => {}),
				5000,
			),
		).toBe(true);
	});
});
