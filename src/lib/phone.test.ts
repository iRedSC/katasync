import { describe, expect, it } from "vitest";
import {
	caretAfterDigits,
	digitsBefore,
	formatPhoneInput,
	telHref,
} from "#/lib/phone";

describe("formatPhoneInput", () => {
	it("shapes a US number as the digits arrive", () => {
		expect(formatPhoneInput("7")).toBe("7");
		expect(formatPhoneInput("717")).toBe("717");
		expect(formatPhoneInput("7177")).toBe("(717) 7");
		expect(formatPhoneInput("717766")).toBe("(717) 766");
		expect(formatPhoneInput("7177660")).toBe("(717) 766-0");
		expect(formatPhoneInput("717.766.0608")).toBe("(717) 766-0608");
	});

	it("drops the country code once the number is whole", () => {
		expect(formatPhoneInput("17177660608")).toBe("(717) 766-0608");
		expect(formatPhoneInput("+1 717 766 0608")).toBe("(717) 766-0608");
		expect(formatPhoneInput("+1 717")).toBe("717");
	});

	it("keeps an extension", () => {
		expect(formatPhoneInput("7177660608 x12")).toBe("(717) 766-0608 ext. 12");
		expect(formatPhoneInput("717-766-0608 ext 5")).toBe(
			"(717) 766-0608 ext. 5",
		);
		expect(formatPhoneInput("7177660608 x")).toBe("(717) 766-0608 ext. ");
	});

	it("waits while ext is being typed", () => {
		expect(formatPhoneInput("(717) 766-0608 e")).toBe("(717) 766-0608 e");
		expect(formatPhoneInput("(717) 766-0608 ex")).toBe("(717) 766-0608 ex");
	});

	it("leaves other countries and overlong numbers as typed", () => {
		expect(formatPhoneInput("+44 20 7946 0958")).toBe("+44 20 7946 0958");
		expect(formatPhoneInput("717766060899")).toBe("717766060899");
	});
});

describe("caret", () => {
	it("lands after the same digits", () => {
		const text = "(717) 766-0608";
		expect(caretAfterDigits(text, 3)).toBe(4);
		expect(caretAfterDigits(text, 4)).toBe(7);
		expect(caretAfterDigits(text, 0)).toBe(1);
		expect(caretAfterDigits(text, 99)).toBe(text.length);
		expect(digitsBefore(text, 7)).toBe(4);
	});
});

describe("telHref", () => {
	it("dials US numbers with +1 and pauses for the extension", () => {
		expect(telHref("(717) 766-0608")).toBe("tel:+17177660608");
		expect(telHref("(717) 766-0608 ext. 12")).toBe("tel:+17177660608,12");
		expect(telHref("+44 20 7946 0958")).toBe("tel:+442079460958");
	});
});
