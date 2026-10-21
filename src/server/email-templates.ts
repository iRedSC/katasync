import { createServerFn } from "@tanstack/react-start";
import { type } from "arktype";
import { getDb } from "#/db/client";
import {
	allTemplates,
	resetTemplate,
	saveTemplate,
	TEMPLATE_KINDS,
} from "#/purchasing/email-templates";

const kind = type.enumerated(...TEMPLATE_KINDS);

export const listEmailTemplates = createServerFn({ method: "GET" }).handler(
	() => allTemplates(getDb()),
);

export type EmailTemplateRow = Awaited<
	ReturnType<typeof listEmailTemplates>
>[number];

export const saveEmailTemplate = createServerFn({ method: "POST" })
	.validator(type({ kind, subject: "string", body: "string" }))
	.handler(({ data }) =>
		saveTemplate(getDb(), data.kind, {
			subject: data.subject,
			body: data.body,
		}),
	);

export const resetEmailTemplate = createServerFn({ method: "POST" })
	.validator(type({ kind }))
	.handler(({ data }) => resetTemplate(getDb(), data.kind));
