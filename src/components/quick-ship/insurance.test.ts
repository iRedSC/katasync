import { describe, expect, test } from "vitest";
import {
	parseInsurance,
	splitInsurance,
	toggleFullCoverage,
	typeInsurance,
} from "./insurance";

describe("insurance field", () => {
	test("nothing typed, or zero, is no insurance", () => {
		expect(parseInsurance("")).toBeNull();
		expect(parseInsurance("0")).toBeNull();
		expect(parseInsurance("0.00")).toBeNull();
		expect(parseInsurance("125.5")).toBe(125.5);
	});

	test("takes digits and cents only", () => {
		expect(typeInsurance("$1,250")).toBe("1250");
		expect(typeInsurance("12.345")).toBe("12.34");
		expect(typeInsurance("1.2.3")).toBe("1.23");
		expect(typeInsurance("s")).toBe("");
	});

	test("tab toggles full coverage", () => {
		expect(toggleFullCoverage("", 812.4)).toBe("812.40");
		expect(toggleFullCoverage("100", 600)).toBe("600");
		expect(toggleFullCoverage("812.40", 812.4)).toBe("");
	});

	test("splits across boxes by the cent", () => {
		expect(splitInsurance(100, 3)).toEqual([33.33, 33.33, 33.34]);
		expect(splitInsurance(null, 2)).toEqual([null, null]);
	});
});
