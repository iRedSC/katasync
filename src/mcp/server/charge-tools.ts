import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Db } from "#/db/client";
import {
	addCharge,
	chargesOf,
	removeCharge,
} from "#/purchasing/orders/charges";
import { landedTerms } from "#/purchasing/orders/revalue";
import { json, WRITE } from "./tool-shapes";

// What a PO cost beyond its lines, and how that's spread over them.
async function chargesFor(db: Db, po: number) {
	const [charges, terms] = await Promise.all([
		chargesOf(db, po),
		landedTerms(db, po),
	]);
	return {
		charges: charges.map((c) => ({ id: c.id, kind: c.kind, amount: c.amount })),
		spreadBy: terms.split.method,
		linesWithoutWeight: terms.split.unweighed.length,
	};
}

export function registerChargeTools(server: McpServer, db: Db) {
	server.registerTool(
		"add_po_charge",
		{
			description:
				"Adds freight, duty, a fee, or a credit (money off the whole PO) to a draft, sent, or closed PO, e.g. the freight line of the supplier's invoice. It's spread over the PO's lines by weight when every product has one, else by value, and becomes part of what each item cost: stock already received is revalued at once, and what's already sold of it shows as a cost correction in profit. The amount is positive, a credit too. Returns the charge's id and the PO's charges.",
			inputSchema: {
				po: z.number().int().positive(),
				kind: z.enum(["freight", "duty", "fee", "credit"]),
				amount: z.number().positive().describe("USD, whole cents"),
			},
			annotations: WRITE,
		},
		async ({ po, kind, amount }) => {
			const row = await addCharge(db, { purchaseOrderId: po, kind, amount });
			return json({ chargeId: row.id, ...(await chargesFor(db, po)) });
		},
	);

	server.registerTool(
		"remove_po_charge",
		{
			description:
				"Takes a charge off its PO, revaluing received stock. Returns what it was, so add_po_charge can put it back.",
			inputSchema: { charge_id: z.number().int().positive() },
			annotations: WRITE,
		},
		async ({ charge_id }) => {
			const removed = await removeCharge(db, charge_id);
			return json({
				removed,
				...(await chargesFor(db, removed.purchaseOrderId)),
			});
		},
	);
}
