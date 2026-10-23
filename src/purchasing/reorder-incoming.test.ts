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
		expect(incoming).toEqual({ timely: 0, aim: 40, unknown: 0, lateDue: 20 });
	});

	test("a delivery before the shelf runs out is in time (due Oct 26)", () => {
		expect(
			incomingFor(TODAY, 5, 1, 44, [{ units: 20, arrivesAt: on(3) }]),
		).toEqual({ timely: 20, aim: 20, unknown: 0, lateDue: null });
	});

	test("back-ordered units have no date, so they're never in time", () => {
		expect(
			incomingFor(TODAY, 9, 1, 44, [{ units: 40, arrivesAt: null }]),
		).toEqual({ timely: 0, aim: 0, unknown: 40, lateDue: null });
	});

	test("an overdue PO has no trustworthy arrival date", () => {
		expect(
			incomingFor(TODAY, 10, 1, 44, [{ units: 10, arrivesAt: on(-3) }]),
		).toEqual({ timely: 0, aim: 0, unknown: 10, lateDue: null });
	});

	test("without sales future supply is in time but overdue supply remains unknown", () => {
		expect(
			incomingFor(TODAY, 0, 0, 44, [
				{ units: 10, arrivesAt: on(-3) },
				{ units: 5, arrivesAt: on(300) },
				{ units: 2, arrivesAt: null },
			]),
		).toEqual({ timely: 5, aim: 5, unknown: 12, lateDue: null });
	});

	test("a delivery in time counts toward the aim even when it lands past the horizon", () => {
		expect(
			incomingFor(TODAY, 100, 1, 44, [{ units: 30, arrivesAt: on(90) }]),
		).toEqual({ timely: 30, aim: 30, unknown: 0, lateDue: null });
	});
});

describe("reorderQuantity with time-aware incoming", () => {
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

	test("orders the full aim when the only supply has no date (on hand 9, back-ordered 40)", () => {
		const input = {
			...base,
			onHand: 9,
			onOrder: 40,
			incoming: incomingFor(TODAY, 9, 1, 44, [{ units: 40, arrivesAt: null }]),
		};
		expect(reorderQuantity(input)).toBe(35);
	});

	test("overdue stock without a new date does not suppress the planned order", () => {
		const input = {
			...base,
			onHand: 10,
			onOrder: 10,
			incoming: incomingFor(TODAY, 10, 1, 44, [
				{ units: 10, arrivesAt: on(-3) },
			]),
		};
		expect(reorderQuantity(input)).toBe(34);
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
		});
		expect(why.untilLate).toBe(6);
		expect(why.verdict).toEqual({
			kind: "order",
			quantity: reorderQuantity(input),
			units: 6,
			roundedUp: null,
		});
	});

	test("keeps back-ordered units out of what's counted, and says so", () => {
		const incoming: Incoming = {
			timely: 0,
			aim: 0,
			unknown: 40,
			lateDue: null,
		};
		const why = explainReorder(
			{ ...base, onHand: 9, onOrder: 40, incoming },
			context,
		);
		expect(why.incoming.unknown).toBe(40);
		expect(why.onOrder - why.incoming.aim).toBe(40);
	});
});
