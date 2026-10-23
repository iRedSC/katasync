import { describe, expect, test } from "vitest";
import { ContentsChanged, Held } from "./packed";
import {
	assertShippable,
	packageFor,
	type TiktokUnit,
	unitsToBuy,
} from "./tiktok-units";

const line = (sku: string | null, quantity: number, lineExternalId = "L") => ({
	orderId: 1,
	lineExternalId,
	productId: null,
	sku,
	title: sku ?? "Untitled",
	quantity,
});
const unit = (id: string, extra: Partial<TiktokUnit> = {}): TiktokUnit => ({
	id,
	skuId: "s1",
	sellerSku: "WRENCH",
	cancelled: false,
	packageId: null,
	...extra,
});
const order = (
	units: TiktokUnit[],
	status = "AWAITING_SHIPMENT",
	packages: string[] = [],
) => ({
	status,
	packages,
	units,
});

describe("unitsToBuy", () => {
	test("every live unit, when they're exactly what was packed", () => {
		const units = [unit("u1"), unit("u2"), unit("u3", { cancelled: true })];
		expect(unitsToBuy(order(units), [line("WRENCH", 2)], true)).toEqual([
			"u1",
			"u2",
		]);
	});

	test("direct TikTok orders match on sku_id, relayed ones on seller SKU", () => {
		const units = [unit("u1", { skuId: "1729", sellerSku: null })];
		expect(unitsToBuy(order(units), [line(null, 1, "1729")], false)).toEqual([
			"u1",
		]);
		expect(() => unitsToBuy(order(units), [line("WRENCH", 1)], true)).toThrow(
			Held,
		);
	});

	test("more or fewer units than packed refuses", () => {
		expect(() =>
			unitsToBuy(order([unit("u1")]), [line("WRENCH", 2)], true),
		).toThrow(ContentsChanged);
	});

	test("a packed line without a SKU can't be matched on a relay", () => {
		expect(() =>
			unitsToBuy(order([unit("u1")]), [line(null, 1)], true),
		).toThrow("no SKU");
	});

	test("an order TikTok has moved on gets no new label", () => {
		expect(() =>
			unitsToBuy(
				order([unit("u1")], "AWAITING_COLLECTION"),
				[line("WRENCH", 1)],
				true,
			),
		).toThrow("no new label");
	});
});

describe("assertShippable", () => {
	const packed = [line("WRENCH", 2)];

	test("the bought units still being every live unit passes", () => {
		expect(() =>
			assertShippable(
				order([unit("u1"), unit("u2")]),
				["u1", "u2"],
				packed,
				true,
			),
		).not.toThrow();
	});

	test("a cancelled unit, or a swapped one, holds", () => {
		expect(() =>
			assertShippable(
				order([unit("u1"), unit("u2", { cancelled: true })]),
				["u1", "u2"],
				packed,
				true,
			),
		).toThrow(ContentsChanged);
		expect(() =>
			assertShippable(
				order([unit("u1"), unit("u9")]),
				["u1", "u2"],
				packed,
				true,
			),
		).toThrow("changed since the label was bought");
	});
});

describe("packageFor", () => {
	test("one package holding exactly the attempt's units is it", () => {
		const units = [
			unit("u1", { packageId: "p" }),
			unit("u2", { packageId: "p" }),
		];
		expect(
			packageFor(order(units, "AWAITING_COLLECTION", ["p"]), ["u1", "u2"]),
		).toMatchObject({
			kind: "bought",
			label: { externalId: "p" },
		});
	});

	test("a package with other units too, or only some of ours, stays unsure", () => {
		const extra = [
			unit("u1", { packageId: "p" }),
			unit("u2", { packageId: "p" }),
			unit("u3", { packageId: "p" }),
		];
		expect(
			packageFor(order(extra, "AWAITING_COLLECTION", ["p"]), ["u1", "u2"]).kind,
		).toBe("pending");
		const split = [
			unit("u1", { packageId: "p" }),
			unit("u2", { packageId: "q" }),
		];
		expect(
			packageFor(order(split, "AWAITING_COLLECTION", ["p", "q"]), ["u1", "u2"])
				.kind,
		).toBe("pending");
		const partly = [unit("u1", { packageId: "p" }), unit("u2")];
		expect(
			packageFor(order(partly, "AWAITING_COLLECTION", ["p"]), ["u1", "u2"])
				.kind,
		).toBe("pending");
	});

	test("a package while TikTok still awaits shipment, or one it doesn't list, stays unsure", () => {
		const units = [unit("u1", { packageId: "p" })];
		expect(
			packageFor(order(units, "AWAITING_SHIPMENT", ["p"]), ["u1"]).kind,
		).toBe("pending");
		expect(
			packageFor(order(units, "AWAITING_COLLECTION", []), ["u1"]).kind,
		).toBe("pending");
	});

	test("no package and nothing listed is none; units gone is unsure", () => {
		expect(packageFor(order([unit("u1")]), ["u1"]).kind).toBe("none");
		expect(
			packageFor(order([unit("u1")], "AWAITING_COLLECTION"), ["u1"]).kind,
		).toBe("pending");
		expect(packageFor(order([]), ["u1"]).kind).toBe("pending");
	});
});
