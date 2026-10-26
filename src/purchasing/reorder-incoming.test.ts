import { describe, expect, test } from "vitest";
import {
	daysUntilReorder,
	explainReorder,
	type Incoming,
	incomingFor,
	type ReorderInput,
	reorderQuantity,
} from "./reorder";

const DAY = 86_400_000;
const TODAY = Date.UTC(2026, 9, 23);
const on = (days: number) => TODAY + days * DAY;

const base: ReorderInput = {
	dailyDemand: 1,
	onHand: 0,
	onOrder: 0,
	leadTimeDays: 14,
	safetyStock: 0,
	coverDays: 30,
	minStock: 0,
	setFloor: 0,
	minimumQuantity: 1,
	packSize: 1,
};

const context = {
	inStockDays: 90,
	rank: 0.5,
	leadTime: { days: 14, from: "supplier" as const, pos: 0 },
	abc: "B" as const,
	purchase: {
		unit: "EACH",
		packSize: 1,
		supplierCount: 1,
		minimumQuantity: 1,
	},
	sets: { shelf: 0, sets: [] },
};

describe("incomingFor", () => {
	test("stock runs out before a PO sent today could land, and the PO due later doesn't cover it (due Nov 12)", () => {
		const incoming = incomingFor(TODAY, 5, 1, 44, [
			{ units: 40, arrivesAt: on(20) },
		]);
		expect(incoming).toEqual({
			timely: 0,
			aim: 40,
			unknown: 0,
			lateDue: 20,
			schedule: [{ units: 40, dueDays: 20 }],
		});
	});

	test("a delivery before the shelf runs out is in time (due Oct 26)", () => {
		expect(
			incomingFor(TODAY, 5, 1, 44, [{ units: 20, arrivesAt: on(3) }]),
		).toEqual({
			timely: 20,
			aim: 20,
			unknown: 0,
			lateDue: null,
			schedule: [{ units: 20, dueDays: 3 }],
		});
	});

	test("back-ordered units have no date, so they're never in time but still cover the aim", () => {
		expect(
			incomingFor(TODAY, 9, 1, 44, [{ units: 40, arrivesAt: null }]),
		).toEqual({ timely: 0, aim: 40, unknown: 40, lateDue: null, schedule: [] });
	});

	test("an overdue PO has no trustworthy arrival date, but is still coming", () => {
		expect(
			incomingFor(TODAY, 10, 1, 44, [{ units: 10, arrivesAt: on(-3) }]),
		).toEqual({ timely: 0, aim: 10, unknown: 10, lateDue: null, schedule: [] });
	});

	test("without sales future supply is in time but overdue supply remains unknown", () => {
		expect(
			incomingFor(TODAY, 0, 0, 44, [
				{ units: 10, arrivesAt: on(-3) },
				{ units: 5, arrivesAt: on(300) },
				{ units: 2, arrivesAt: null },
			]),
		).toEqual({
			timely: 5,
			aim: 17,
			unknown: 12,
			lateDue: null,
			schedule: [{ units: 5, dueDays: 300 }],
		});
	});

	test("a delivery in time counts toward the aim even when it lands past the horizon", () => {
		expect(
			incomingFor(TODAY, 100, 1, 44, [{ units: 30, arrivesAt: on(90) }]),
		).toEqual({
			timely: 30,
			aim: 30,
			unknown: 0,
			lateDue: null,
			schedule: [{ units: 30, dueDays: 90 }],
		});
	});
});

describe("reorderQuantity with time-aware incoming", () => {
	test("bridges every delivery gap, not just the first late arrival", () => {
		const input = {
			...base,
			onHand: 5,
			onOrder: 101,
			incoming: incomingFor(TODAY, 5, 1, 44, [
				{ units: 100, arrivesAt: on(40) },
				{ units: 1, arrivesAt: on(20) },
			]),
		};
		expect(reorderQuantity(input)).toBe(25);
		expect(explainReorder(input, context).untilLate).toBe(25);
	});

	test("a far-future delivery cannot extend today's purchase horizon", () => {
		const input = {
			...base,
			onHand: 5,
			onOrder: 100,
			incoming: incomingFor(TODAY, 5, 1, 44, [
				{ units: 100, arrivesAt: on(365) },
			]),
		};
		expect(reorderQuantity(input)).toBe(39);
		expect(explainReorder(input, context).untilLate).toBe(30);
	});

	test.each([
		null,
		on(-3),
	])("unknown or overdue supply covers the oversold floor (%s)", (arrivesAt) => {
		const input = {
			...base,
			dailyDemand: 0,
			onHand: -5,
			onOrder: 40,
			packSize: 6,
			minimumQuantity: 2,
			incoming: incomingFor(TODAY, -5, 0, 44, [{ units: 40, arrivesAt }]),
		};
		expect(reorderQuantity(input)).toBe(0);
		expect(explainReorder(input, context)).toMatchObject({
			minFrom: "oversold",
			verdict: { kind: "undated", units: 40 },
		});
	});

	test("does not order a supplier minimum when late supply already covers the aim and bridge", () => {
		expect(
			reorderQuantity({
				...base,
				onHand: 5,
				onOrder: 100,
				minimumQuantity: 12,
				incoming: incomingFor(TODAY, 5, 1, 44, [
					{ units: 100, arrivesAt: on(10) },
				]),
			}),
		).toBe(0);
	});
	test("orders when stock runs out before a late PO lands (on hand 5, PO due Nov 12)", () => {
		const input = {
			...base,
			onHand: 5,
			onOrder: 40,
			incoming: incomingFor(TODAY, 5, 1, 44, [
				{ units: 40, arrivesAt: on(20) },
			]),
		};
		expect(reorderQuantity(input)).toBe(6);
		expect(daysUntilReorder(input)).toBeNull();
	});

	test("without timing, the late PO hides the shortfall and nothing is ordered", () => {
		expect(reorderQuantity({ ...base, onHand: 5, onOrder: 40 })).toBe(0);
	});

	test("waits when a delivery lands in time (on hand 5, PO due Oct 26)", () => {
		const input = {
			...base,
			onHand: 5,
			onOrder: 20,
			incoming: incomingFor(TODAY, 5, 1, 44, [{ units: 20, arrivesAt: on(3) }]),
		};
		expect(reorderQuantity(input)).toBe(0);
		expect(daysUntilReorder(input)).toBe(11);
	});

	test("doesn't order again what's back-ordered (on hand 9, back-ordered 40)", () => {
		const input = {
			...base,
			onHand: 9,
			onOrder: 40,
			incoming: incomingFor(TODAY, 9, 1, 44, [{ units: 40, arrivesAt: null }]),
		};
		expect(reorderQuantity(input)).toBe(0);
	});

	test("orders only what overdue stock leaves short (on hand 10, 10 overdue)", () => {
		const input = {
			...base,
			onHand: 10,
			onOrder: 10,
			incoming: incomingFor(TODAY, 10, 1, 44, [
				{ units: 10, arrivesAt: on(-3) },
			]),
		};
		expect(reorderQuantity(input)).toBe(24);
	});

	test("orders whole cases for the shortfall, with one of two cases already received (due Nov 22)", () => {
		const input = {
			...base,
			onHand: 3,
			onOrder: 12,
			packSize: 12,
			coverDays: 20,
			incoming: incomingFor(TODAY, 3, 1, 34, [
				{ units: 12, arrivesAt: on(30) },
			]),
		};
		expect(reorderQuantity(input)).toBe(2);
		expect(explainReorder(input, context).verdict).toMatchObject({
			kind: "order",
			quantity: 2,
			units: 24,
			roundedUp: "pack",
		});
	});

	test("with no sales, a delivery already on the way still keeps min stock on the shelf", () => {
		const input = {
			...base,
			dailyDemand: 0,
			minStock: 3,
			onHand: 0,
			onOrder: 10,
			incoming: incomingFor(TODAY, 0, 0, 44, [
				{ units: 10, arrivesAt: on(100) },
			]),
		};
		expect(reorderQuantity(input)).toBe(0);
	});
});

describe("explainReorder with time-aware incoming", () => {
	test("shows the shortage when another purchase cannot arrive before existing supply", () => {
		const input = {
			...base,
			onHand: 5,
			onOrder: 100,
			incoming: incomingFor(TODAY, 5, 1, 44, [
				{ units: 100, arrivesAt: on(10) },
			]),
		};
		expect(reorderQuantity(input)).toBe(0);
		expect(explainReorder(input, context).verdict).toEqual({
			kind: "awaiting",
			days: 10,
			gapDays: 5,
		});
	});

	test("says what's late and what the order covers until it lands (PO due Nov 12)", () => {
		const input = {
			...base,
			onHand: 5,
			onOrder: 40,
			incoming: incomingFor(TODAY, 5, 1, 44, [
				{ units: 40, arrivesAt: on(20) },
			]),
		};
		const why = explainReorder(input, context);
		expect(why.incoming).toEqual({
			timely: 0,
			aim: 40,
			unknown: 0,
			lateDue: 20,
			schedule: [{ units: 40, dueDays: 20 }],
		});
		expect(why.untilLate).toBe(6);
		expect(why.verdict).toEqual({
			kind: "order",
			quantity: reorderQuantity(input),
			units: 6,
			roundedUp: null,
		});
	});

	test("counts back-ordered units and says it's awaiting them", () => {
		const incoming: Incoming = {
			timely: 0,
			aim: 40,
			unknown: 40,
			lateDue: null,
			schedule: [],
		};
		const why = explainReorder(
			{ ...base, onHand: 9, onOrder: 40, incoming },
			context,
		);
		expect(why.verdict).toEqual({ kind: "undated", units: 40 });
		expect(why.onOrder - why.incoming.aim).toBe(0);
	});
});
