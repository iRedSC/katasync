import { describe, expect, test } from "vitest";
import { renderTemplate, templateProblems } from "./email-templates";

const values = {
	greeting: "Hi Sam,",
	po: "1042",
	supplier: "Tool Source",
	from: "East Coast Drywall Tools",
	items: "3 items",
};

describe("placeholder grammar", () => {
	test("a name that isn't a placeholder is refused, in saving and sending", () => {
		for (const name of ["PO", "po1", "po-number"]) {
			const body = `{${name}}`;
			expect(
				templateProblems("purchase_order", { subject: "PO", body }),
			).toEqual([`{${name}} isn't a placeholder this email has`]);
			expect(() => renderTemplate({ subject: "PO", body }, values)).toThrow(
				`{${name}} isn't a placeholder this email has`,
			);
		}
	});

	test("an unmatched brace is refused, in either direction", () => {
		expect(
			templateProblems("purchase_order", { subject: "PO", body: "{po" }),
		).toEqual(["A { has no matching }. Write {{ for a literal {"]);
		expect(
			templateProblems("purchase_order", { subject: "PO", body: "po}" }),
		).toEqual(["A } has no matching {. Write }} for a literal }"]);
	});

	test("doubled braces are literal, and never fill a placeholder", () => {
		const { text } = renderTemplate(
			{ subject: "PO", body: "Ref {{po}} for {po}" },
			values,
		);
		expect(text).toBe("Ref {po} for 1042");
		expect(
			templateProblems("purchase_order", { subject: "PO", body: "{{po}}" }),
		).toEqual([]);
	});

	test("a known placeholder still fills in", () => {
		expect(
			renderTemplate({ subject: "PO {po}", body: "{greeting}" }, values),
		).toEqual({ subject: "PO 1042", text: "Hi Sam," });
	});

	test("the damage list appears exactly once in the body", () => {
		expect(
			templateProblems("damage_report", {
				subject: "Damage",
				body: "{damage_list} {damage_list}",
			}),
		).toEqual(["{damage_list} can only appear once"]);
	});
});
