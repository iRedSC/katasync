import { eq } from "drizzle-orm";
import type { Db } from "#/db/client";
import { packages, shipments } from "#/db/schema";
import { boxLabel } from "#/shipping/box-filter";

// The boxes quick ship offers, found by size or name. Entered in inches and ounces, the units
// on the tape measure and scale, and stored in millimeters and grams like
// everything else.

const MM_PER_INCH = 25.4;
const GRAMS_PER_OUNCE = 28.349523125;

export class BoxError extends Error {
	name = "BoxError";
}

export type BoxInput = {
	// Blank or left out: the box goes by its size.
	name?: string | null;
	lengthIn: number;
	widthIn: number;
	heightIn: number;
	weightOz: number;
};

function boxValues(data: BoxInput) {
	for (const [label, value] of [
		["length", data.lengthIn],
		["width", data.widthIn],
		["height", data.heightIn],
	] as const)
		if (!(value > 0)) throw new BoxError(`The ${label} must be over 0`);
	if (!(data.weightOz >= 0)) throw new BoxError("The weight can't be negative");
	return {
		name: data.name?.trim() || null,
		lengthMm: Math.round(data.lengthIn * MM_PER_INCH),
		widthMm: Math.round(data.widthIn * MM_PER_INCH),
		heightMm: Math.round(data.heightIn * MM_PER_INCH),
		weightGrams: Math.round(data.weightOz * GRAMS_PER_OUNCE),
	};
}

// Adds boxes, all or none.
export async function createBoxes(db: Db, boxes: BoxInput[]) {
	return db.transaction(async (tx) => {
		const saved = [];
		for (const box of boxes) {
			const [row] = await tx
				.insert(packages)
				.values(boxValues(box))
				.returning();
			saved.push(row);
		}
		return saved;
	});
}

// Everything about a box can change. Past labels keep pointing at it.
export async function updateBox(db: Db, id: number, box: BoxInput) {
	const [saved] = await db
		.update(packages)
		.set(boxValues(box))
		.where(eq(packages.id, id))
		.returning();
	if (!saved) throw new BoxError("No such box");
	return saved;
}

// Past shipments keep their box, so a box that shipped stays.
export async function deleteBox(db: Db, id: number) {
	const [used] = await db
		.select({
			name: packages.name,
			lengthMm: packages.lengthMm,
			widthMm: packages.widthMm,
			heightMm: packages.heightMm,
		})
		.from(shipments)
		.innerJoin(packages, eq(packages.id, shipments.packageId))
		.where(eq(shipments.packageId, id))
		.limit(1);
	if (used)
		throw new BoxError(
			`${boxLabel(used)} is on past labels, so it can't be removed`,
		);
	const removed = await db
		.delete(packages)
		.where(eq(packages.id, id))
		.returning({ id: packages.id });
	if (removed.length === 0) throw new BoxError("No such box");
}
