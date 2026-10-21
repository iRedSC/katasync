import { describe, expect, test } from "vitest";
import { createTestDb } from "#/test/db";
import {
	DEFAULT_TEMPLATES,
	renderTemplate,
	resetTemplate,
	saveTemplate,
	templateFor,
	templateProblems,
} from "./email-templates";

const poValues = {
	greeting: "Hi Sam,",
	po: "1042",
	supplier: "Tool Source",
	from: "East Coast Drywall Tools",
	items: "3 items",
};

describe("email templates", () => {
	test("the default PO email reads as it always has", () => {
		expect(renderTemplate(DEFAULT_TEMPLATES.purchase_order, poValues)).toEqual({
			subject: "Purchase order 1042 from East Coast Drywall Tools",
			text: "Hi Sam,\n\nPlease find purchase order 1042 attached (3 items). Reply to this email to confirm, or with any changes or backorders.\n\nThank you,\nEast Coast Drywall Tools",
		});
	});

	test("an empty placeholder leaves no gap", () => {
		const { text } = renderTemplate(DEFAULT_TEMPLATES.damage_report, {
			...poValues,
			damage_list: "- 2 × Blade (BLADE): bent. Please credit us.",
			photos: "",
		});
		expect(text).toContain("Please credit us.\n\nThank you,");
	});

	test("refuses placeholders the email doesn't have, and a missing damage list", () => {
		expect(
			templateProblems("purchase_order", {
				subject: "PO {po}",
				body: "{greating} {damage_list}",
			}),
		).toEqual([
			"{greating} isn't a placeholder this email has",
			"{damage_list} isn't a placeholder this email has",
		]);
		expect(
			templateProblems("damage_report", {
				subject: "{damage_list}",
				body: "Hi",
			}),
		).toEqual([
			"The body needs {damage_list}",
			"{damage_list} can't go in the subject",
		]);
		expect(
			templateProblems("purchase_order", DEFAULT_TEMPLATES.purchase_order),
		).toEqual([]);
		expect(
			templateProblems("damage_report", DEFAULT_TEMPLATES.damage_report),
		).toEqual([]);
	});

	test("saves wording, refuses a broken one, and goes back to the default", async () => {
		const db = await createTestDb();
		await saveTemplate(db, "purchase_order", {
			subject: "PO {po}",
			body: "{greeting}\nOrder attached.",
		});
		expect(await templateFor(db, "purchase_order")).toMatchObject({
			subject: "PO {po}",
			custom: true,
		});
		await expect(
			saveTemplate(db, "damage_report", { subject: "x", body: "no list" }),
		).rejects.toThrow("The body needs {damage_list}");
		await resetTemplate(db, "purchase_order");
		expect(await templateFor(db, "purchase_order")).toEqual({
			...DEFAULT_TEMPLATES.purchase_order,
			custom: false,
		});
	});
});
