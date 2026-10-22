import { describe, expect, test, vi } from "vitest";
import { QueryError, withConnectionSlot } from "./query";

const tick = () => new Promise((r) => setTimeout(r, 0));

describe("isolated query connections", () => {
	test("at most four run at once, and each freed slot goes to the next call", async () => {
		let active = 0;
		let most = 0;
		const release: (() => void)[] = [];
		const job = () =>
			withConnectionSlot(async () => {
				active++;
				most = Math.max(most, active);
				await new Promise<void>((done) => release.push(done));
				active--;
			});
		const jobs = Array.from({ length: 6 }, job);
		await tick();
		expect(release).toHaveLength(4);
		release.shift()?.();
		await tick();
		expect(release).toHaveLength(4);
		while (release.length > 0) {
			release.shift()?.();
			await tick();
		}
		await Promise.all(jobs);
		expect(most).toBe(4);
	});

	test("a call that waits too long is refused with a message, and leaves the line", async () => {
		vi.useFakeTimers();
		try {
			const holds: (() => void)[] = [];
			for (let i = 0; i < 4; i++)
				void withConnectionSlot(
					() => new Promise<void>((done) => holds.push(done)),
				);
			await vi.advanceTimersByTimeAsync(0);
			const late = withConnectionSlot(async () => "ran").catch((e) => e);
			await vi.advanceTimersByTimeAsync(10_000);
			expect(await late).toBeInstanceOf(QueryError);
			for (const done of holds) done();
			await vi.advanceTimersByTimeAsync(0);
		} finally {
			vi.useRealTimers();
		}
		await tick();
		expect(await withConnectionSlot(async () => "ran")).toBe("ran");
	});
});
