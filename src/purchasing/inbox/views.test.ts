import { describe, expect, it } from "vitest";
import { likelihood, mentionedPos } from "./views";

describe("mentionedPos", () => {
	it("reads the ways suppliers write a PO number", () => {
		expect([
			...mentionedPos("Re: PO 1234, P.O. #88 and order 456; see #77"),
		]).toEqual([1234, 88, 456, 77]);
	});

	it("leaves numbers that aren't PO numbers", () => {
		expect(mentionedPos("Port 8080, report 12, 3 boxes").size).toBe(0);
	});
});

describe("likelihood", () => {
	const email = {
		fromAddress: "sales@acme.com",
		subject: "Invoice for PO 42",
		body: "",
	};

	it("puts a PO the email names first", () => {
		expect(likelihood(email, { id: 42, supplierEmail: "x@other.com" })).toBe(
			"mentions",
		);
	});

	it("falls back to the supplier's domain", () => {
		expect(likelihood(email, { id: 7, supplierEmail: "orders@ACME.com" })).toBe(
			"supplier",
		);
		expect(likelihood(email, { id: 7, supplierEmail: null })).toBeNull();
	});
});
