import { createServerFn } from "@tanstack/react-start";
import { type } from "arktype";
import { getDb } from "#/db/client";
import { runCheck } from "#/diagnostics/checks";
import { dismiss, restore } from "#/diagnostics/dismissals";
import { diagnosticsOverview } from "#/diagnostics/overview";

export const getDiagnostics = createServerFn({ method: "GET" }).handler(
	async () => {
		// Unmatched SKUs are worked from Listings; agents still read them
		// through sync_status.
		const { unmapped: _, ...overview } = await diagnosticsOverview(getDb());
		return overview;
	},
);

export type Diagnostics = Awaited<ReturnType<typeof getDiagnostics>>;

export const runConnectionCheck = createServerFn({ method: "POST" })
	.validator(
		type({
			target: "'shopify' | 'ebay' | 'amazon' | 'tiktok' | 'shippo' | 'email'",
		}),
	)
	.handler(async ({ data }) => runCheck(data.target));

const channel = "'shopify' | 'ebay' | 'amazon' | 'tiktok'";
const dismissTarget = type({
	target: type({
		kind: "'handoff'",
		dispatchId: "number.integer > 0",
		orderId: "number.integer > 0",
	})
		.or({ kind: "'storefront'", shipmentId: "number.integer > 0" })
		.or({ kind: "'charges'", billedBy: channel, error: "string" })
		.or({ kind: "'issue'", channel, message: "string" }),
});

export const dismissProblem = createServerFn({ method: "POST" })
	.validator(dismissTarget)
	.handler(async ({ data }) => dismiss(getDb(), data.target));

export const restoreProblem = createServerFn({ method: "POST" })
	.validator(dismissTarget)
	.handler(async ({ data }) => restore(getDb(), data.target));
