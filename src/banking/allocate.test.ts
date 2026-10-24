import { describe, expect, it } from "vitest";
import { checkAllocation, driftOf, type Standing } from "./allocate";
import { suggest } from "./suggest";
import { payoutTarget, targetKey } from "./targets";

const payout = (
	id: number,
	amountCents: number,
	more: Partial<Standing> = {},
): Standing => ({
	ref: { kind: "payout", id },
	label: `Payout ${id}`,
	amountCents,
	currency: "USD",
	status: "sent",
	reference: null,
	on: "2026-10-01",
	refusal: null,
	allocatedCents: 0,
	...more,
});

const standing = (...ps: Standing[]) =>
	new Map(ps.map((p) => [targetKey(p.ref), p]));
const bank: {
	amountCents: number;
	currency: string;
	reference?: string | null;
} = { amountCents: 10000, currency: "USD" };
const part = (id: number, amountCents: number) => ({
	target: { kind: "payout" as const, id },
	amountCents,
});

describe("checkAllocation", () => {
	it("takes a split that adds up to the bank row exactly", () => {
		const r = checkAllocation(
			bank,
			[part(1, 6000), part(2, 4000)],
			standing(payout(1, 6000), payout(2, 4000)),
		);
		expect(r.ok).toBe(true);
	});

	it("takes part of a payout, leaving the rest for another deposit", () => {
		expect(
			checkAllocation(bank, [part(1, 10000)], standing(payout(1, 15000))).ok,
		).toBe(true);
	});

	it("refuses parts a cent short or over", () => {
		const s = standing(payout(1, 6000), payout(2, 4001));
		expect(checkAllocation(bank, [part(1, 6000), part(2, 3999)], s)).toEqual({
			ok: false,
			problem: expect.stringContaining("add to"),
		});
		expect(checkAllocation(bank, [part(1, 6000), part(2, 4001)], s).ok).toBe(
			false,
		);
	});

	it("refuses matching a payout past what's left of it", () => {
		const r = checkAllocation(
			bank,
			[part(1, 10000)],
			standing(payout(1, 15000, { allocatedCents: 9000 })),
		);
		expect(r).toEqual({
			ok: false,
			problem: expect.stringContaining("left to match"),
		});
	});

	it("refuses another currency, a failed payout, the wrong direction, and a payout twice", () => {
		expect(
			checkAllocation(
				bank,
				[part(1, 10000)],
				standing(payout(1, 10000, { currency: "CAD" })),
			),
		).toEqual({
			ok: false,
			problem: expect.stringContaining("conversion"),
		});
		expect(
			checkAllocation(
				bank,
				[part(1, 10000)],
				standing(payout(1, 10000, { refusal: "failed" })),
			).ok,
		).toBe(false);
		expect(
			checkAllocation(bank, [part(1, -10000)], standing(payout(1, -10000))).ok,
		).toBe(false);
		expect(
			checkAllocation(
				bank,
				[part(1, 5000), part(1, 5000)],
				standing(payout(1, 10000)),
			).ok,
		).toBe(false);
		expect(
			checkAllocation(bank, [part(1, 100.5)], standing(payout(1, 10000))).ok,
		).toBe(false);
		expect(checkAllocation(bank, [], standing()).ok).toBe(false);
	});

	it("matches money taken back against a negative payout", () => {
		expect(
			checkAllocation(
				{ amountCents: -500, currency: "USD" },
				[part(1, -500)],
				standing(payout(1, -500)),
			).ok,
		).toBe(true);
	});
});

describe("driftOf", () => {
	const seen = {
		amountCents: 10000,
		currency: "USD",
		status: "pending",
		reference: null as string | null,
	};
	const drift = (current: Partial<typeof seen> | null) =>
		driftOf(seen, current && { ...seen, ...current }, payoutTarget.progresses);

	it("lets a pending payout become sent, and a reference arrive", () => {
		expect(drift({ status: "sent", reference: "TRACE1" })).toEqual([]);
	});

	it("flags a changed amount, currency, failure, or a payout gone", () => {
		expect(drift({ amountCents: 9999 })).toEqual([
			{ field: "amount", before: 10000, after: 9999 },
		]);
		expect(drift({ currency: "CAD" })[0]).toMatchObject({ field: "currency" });
		expect(drift({ status: "failed" })[0]).toMatchObject({ field: "status" });
		expect(drift(null)).toEqual([{ field: "missing" }]);
	});

	it("flags a reference that changed once known", () => {
		expect(
			driftOf(
				{ ...seen, reference: "A" },
				{ ...seen, reference: "B" },
				payoutTarget.progresses,
			)[0],
		).toMatchObject({
			field: "reference",
		});
	});
});

describe("suggest", () => {
	const row = {
		amountCents: 10000,
		currency: "USD",
		postedOn: "2026-10-02",
		description: "SHOPIFY TRANSFER",
	};

	it("offers payouts that fit, and says when more than one does", () => {
		const r = suggest(row, [
			payout(1, 10000),
			payout(2, 10000, { on: "2026-10-02" }),
		]);
		expect(r.suggestions).toHaveLength(2);
		expect(r.ambiguous).toBe(true);
	});

	it("finds combinations, and leaves out other currencies and failed payouts", () => {
		const r = suggest(row, [
			payout(1, 6000),
			payout(2, 4000),
			payout(3, 10000, { currency: "CAD" }),
			payout(4, 10000, { refusal: "failed" }),
		]);
		expect(r.suggestions.map((s) => s.parts.map((p) => p.target.id))).toEqual([
			[1, 2],
		]);
		expect(r.ambiguous).toBe(false);
	});

	it("puts a payout whose reference the bank shows first", () => {
		const r = suggest({ ...row, description: "AMZN TRACE 60S17855" }, [
			payout(1, 10000, { on: "2026-10-02" }),
			payout(2, 10000, { reference: "60S17855" }),
		]);
		expect(r.suggestions[0].parts[0].target.id).toBe(2);
		expect(r.ambiguous).toBe(false);
	});

	it("only suggests what's left of a partly matched payout", () => {
		const r = suggest(row, [payout(1, 15000, { allocatedCents: 5000 })]);
		expect(r.suggestions[0].parts).toEqual([part(1, 10000)]);
	});
});
