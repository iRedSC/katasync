import { createServerFn } from "@tanstack/react-start";
import { type } from "arktype";
import { getDb } from "#/db/client";
import { runCheck } from "#/diagnostics/checks";
import { diagnosticsOverview } from "#/diagnostics/overview";

export const getDiagnostics = createServerFn({ method: "GET" }).handler(
	async () => diagnosticsOverview(getDb()),
);

export type Diagnostics = Awaited<ReturnType<typeof getDiagnostics>>;

export const runConnectionCheck = createServerFn({ method: "POST" })
	.validator(
		type({
			target: "'shopify' | 'ebay' | 'amazon' | 'tiktok' | 'shippo' | 'email'",
		}),
	)
	.handler(async ({ data }) => runCheck(data.target));
