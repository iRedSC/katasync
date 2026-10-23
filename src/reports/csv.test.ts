import { describe, expect, it } from "vitest";
import { csvCell, csvText, decimal } from "./csv";

describe("csvCell", () => {
	it("defuses text a spreadsheet would run as a formula", () => {
		expect(csvCell('=HYPERLINK("http://x")')).toBe(
			'"\'=HYPERLINK(""http://x"")"',
		);
		expect(csvCell("+1")).toBe("'+1");
		expect(csvCell("-1")).toBe("'-1");
		expect(csvCell("@SUM(A1)")).toBe("'@SUM(A1)");
		expect(csvCell("\tcmd")).toBe("'\tcmd");
		expect(csvCell("  =1+1")).toBe("'  =1+1");
	});

	it("leaves money and counts as numbers, negative included", () => {
		expect(csvCell(decimal(-12.5))).toBe("-12.50");
		expect(csvCell(decimal(0.1 + 0.2))).toBe("0.30");
		expect(csvCell(-3)).toBe("-3");
		expect(csvCell(decimal(Number.NaN))).toBe("");
		expect(csvCell(Number.POSITIVE_INFINITY)).toBe("");
	});

	it("quotes commas, quotes and line breaks of any kind", () => {
		expect(csvCell('Bob "B", Inc')).toBe('"Bob ""B"", Inc"');
		expect(csvCell("line\nbreak")).toBe('"line\nbreak"');
		expect(csvCell("line\r\nbreak")).toBe('"line\r\nbreak"');
		expect(csvCell("cr\ronly")).toBe('"cr\ronly"');
		expect(csvCell(" padded ")).toBe('" padded "');
	});

	it("writes blank for null and plain text as is", () => {
		expect(csvCell(null)).toBe("");
		expect(csvCell("Amazon")).toBe("Amazon");
	});
});

describe("csvText", () => {
	it("ends every row, the last too, with CRLF", () => {
		expect(
			csvText([
				["a", "b"],
				[1, decimal(2)],
			]),
		).toBe("a,b\r\n1,2.00\r\n");
	});

	it("keeps a newline inside a quoted cell from splitting the row", () => {
		const text = csvText([
			["Reference", "Amount"],
			["x\ny", decimal(1)],
		]);
		expect(text).toBe('Reference,Amount\r\n"x\ny",1.00\r\n');
		expect(text.split("\r\n")).toHaveLength(3);
	});
});
