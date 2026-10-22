import { describe, expect, test, vi } from "vitest";
import { boxQuoter } from "./box-quotes";
import { type Address, getRates } from "./shippo";

vi.mock("./shippo", () => ({
	getRates: vi.fn(async () => ({ rates: [], notes: [] })),
}));

const addresses = {
	from: { name: "From" } as Address,
	to: { name: "To" } as Address,
};
const box = (over: object = {}) => ({
	lengthMm: 100,
	widthMm: 100,
	heightMm: 100,
	weightGrams: 500,
	hazmat: false,
	insureAmount: null,
	...over,
});

describe("boxQuoter", () => {
	test("identical boxes with the same extras are priced once", async () => {
		vi.mocked(getRates).mockClear();
		const quote = boxQuoter(addresses);
		await Promise.all([quote(box(), false, false), quote(box(), false, false)]);
		expect(getRates).toHaveBeenCalledTimes(1);
	});

	test("an extra that changes the request is priced again", async () => {
		vi.mocked(getRates).mockClear();
		const quote = boxQuoter(addresses);
		const insured = box({ insureAmount: 300 });
		await quote(insured, true, false);
		await quote(insured, false, false);
		await quote(insured, true, true);
		expect(getRates).toHaveBeenCalledTimes(3);
	});

	test("never more than four requests in flight", async () => {
		vi.mocked(getRates).mockClear();
		let running = 0;
		let peak = 0;
		vi.mocked(getRates).mockImplementation(async () => {
			running++;
			peak = Math.max(peak, running);
			await new Promise((done) => setTimeout(done, 5));
			running--;
			return { rates: [], notes: [] };
		});
		const quote = boxQuoter(addresses);
		await Promise.all(
			Array.from({ length: 10 }, (_, i) =>
				quote(box({ lengthMm: i + 1 }), false, false),
			),
		);
		expect(peak).toBe(4);
	});
});
