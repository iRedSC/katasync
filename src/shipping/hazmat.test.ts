import { PDFDocument } from "pdf-lib";
import { describe, expect, test } from "vitest";
import { appendAerosolMark, shipsAerosols } from "./hazmat";

describe("shipsAerosols", () => {
	test.each([
		["USPS Ground Advantage", true],
		["USPS Priority Mail", false],
		["USPS Priority Mail Express", false],
		["UPS Ground", true],
		["UPS® Ground", true],
		["UPS Ground Saver", false],
		["UPS 2nd Day Air®", false],
		["FedEx Ground", true],
		["FedEx Home Delivery", true],
		["FedEx 2Day", false],
		["DHL Express Worldwide", false],
	])("%s: %s", (serviceName, ok) => {
		expect(shipsAerosols({ serviceName })).toBe(ok);
	});
});

describe("appendAerosolMark", () => {
	test("adds a 4x6 page after the label", async () => {
		const label = await PDFDocument.create();
		label.addPage([288, 432]);
		const out = await PDFDocument.load(
			await appendAerosolMark(await label.save()),
		);
		expect(out.getPageCount()).toBe(2);
		expect(out.getPage(1).getSize()).toEqual({ width: 288, height: 432 });
	});
});
