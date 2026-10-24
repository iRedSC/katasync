import { and, eq, inArray } from "drizzle-orm";
import type { Db } from "#/db/client";
import { locations, stockLevels } from "#/db/schema";
import { ourKinds } from "#/inventory/locations";
import {
	assertPositiveInteger,
	LedgerError,
	lockStockProducts,
	postMovements,
} from "./post";

export type TransitLeg = "dispatch" | "receive";

export async function postTransitLeg(
	db: Db,
	input: {
		leg: TransitLeg;
		fromLocationId: number;
		toLocationId: number;
		lines: { productId: number; quantity: number }[];
		reference: string;
		note?: string;
	},
) {
	if (input.lines.length === 0) throw new LedgerError("Nothing to move");
	for (const line of input.lines) assertPositiveInteger(line.quantity);
	if (new Set(input.lines.map((l) => l.productId)).size !== input.lines.length)
		throw new LedgerError("Each product moves once per leg");
	return db.transaction(async (tx) => {
		const locked = await lockStockProducts(
			tx,
			input.lines.map((l) => l.productId),
		);
		const sets = locked.filter((p) => p.kind === "bundle");
		if (sets.length > 0)
			throw new LedgerError(
				`Tool sets move as their parts: ${sets.map((s) => s.sku).join(", ")}`,
			);
		const ends = await tx
			.select({ id: locations.id, name: locations.name, kind: locations.kind })
			.from(locations)
			.where(inArray(locations.id, [input.fromLocationId, input.toLocationId]));
		const from = ends.find((l) => l.id === input.fromLocationId);
		const to = ends.find((l) => l.id === input.toLocationId);
		const ours = (kind: string | undefined) =>
			(ourKinds as readonly string[]).includes(kind ?? "");
		const shaped =
			input.leg === "dispatch"
				? ours(from?.kind) && to?.kind === "transit"
				: from?.kind === "transit" && ours(to?.kind);
		if (!from || !to || !shaped)
			throw new LedgerError(
				input.leg === "dispatch"
					? "A dispatch leaves one of our locations for transit"
					: "A receipt leaves transit for one of our locations",
			);
		const held = await tx
			.select({ productId: stockLevels.productId, onHand: stockLevels.onHand })
			.from(stockLevels)
			.where(
				and(
					eq(stockLevels.locationId, from.id),
					inArray(
						stockLevels.productId,
						input.lines.map((l) => l.productId),
					),
				),
			)
			.orderBy(stockLevels.productId)
			.for("update");
		const short = input.lines.flatMap((line) => {
			const has = held.find((h) => h.productId === line.productId)?.onHand ?? 0;
			return has < line.quantity ? [{ ...line, has: Math.max(0, has) }] : [];
		});
		if (short.length > 0) {
			const sku = (id: number) => locked.find((p) => p.id === id)?.sku;
			throw new LedgerError(
				`${short.map((s) => `${from.name} has ${s.has} of ${sku(s.productId)}, not ${s.quantity}`).join("; ")}.`,
			);
		}
		return postMovements(tx, {
			reference: input.reference,
			note: input.note?.trim() || undefined,
			lines: input.lines.flatMap((line) => [
				{
					productId: line.productId,
					locationId: from.id,
					delta: -line.quantity,
					reason: "transfer_out" as const,
				},
				{
					productId: line.productId,
					locationId: to.id,
					delta: line.quantity,
					reason: "transfer_in" as const,
				},
			]),
		});
	});
}
