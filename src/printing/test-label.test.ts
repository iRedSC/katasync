import { expect, test } from "vitest";
import { renderTestLabel } from "./test-label";

test("the test label is a one-page 4x6 PDF", async () => {
	const pdf = (await renderTestLabel()).toString("latin1");
	expect(pdf.startsWith("%PDF")).toBe(true);
	expect(pdf).toMatch(/\/MediaBox \[0 0 288 432\]/);
	expect(pdf.match(/\/Type \/Page\b/g)).toHaveLength(1);
});
