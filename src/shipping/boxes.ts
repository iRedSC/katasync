import { eq } from "drizzle-orm";
import type { Db } from "#/db/client";
import { packages } from "#/db/schema";
import { freePackagePin } from "#/shipping/quick-ship";

// The boxes quick ship knows by pin. Entered in inches and ounces, the units
// on the tape measure and scale, and stored in millimeters and grams like
// everything else.

const MM_PER_INCH = 25.4;
const GRAMS_PER_OUNCE = 28.349523125;

export class BoxError extends Error {
	name = "BoxError";
}

export type BoxInput = {
	name: string;
	lengthIn: number;
	widthIn: number;
	heightIn: number;
	weightOz: number;
	// Chosen when left out: the lowest free pin.
	pin?: number;
};

function boxValues(data: BoxInput) {
	for (const [label, value] of [
		["length", data.lengthIn],
		["width", data.widthIn],
		["height", data.heightIn],
	] as const)
		if (!(value > 0)) throw new BoxError(`The ${label} must be over 0`);
	if (!(data.weightOz >= 0)) throw new BoxError("The weight can't be negative");
	if (
		data.pin !== undefined &&
		!(Number.isInteger(data.pin) && data.pin >= 1 && data.pin <= 999)
	)
		throw new BoxError(`A pin is 1 to 999, got ${data.pin}`);
	const name = data.name.trim();
	if (name === "") throw new BoxError("Give the box a name");
	return {
		name,
		lengthMm: Math.round(data.lengthIn * MM_PER_INCH),
		widthMm: Math.round(data.widthIn * MM_PER_INCH),
		heightMm: Math.round(data.heightIn * MM_PER_INCH),
		weightGrams: Math.round(data.weightOz * GRAMS_PER_OUNCE),
	};
}

// Says which box already has a pin, rather than a database error.
async function refuseTakenPin(db: Db, pin: number, exceptId?: number) {
	const [taken] = await db
		.select({ id: packages.id, name: packages.name })
		.from(packages)
		.where(eq(packages.pin, pin));
	if (taken && taken.id !== exceptId)
		throw new BoxError(`Pin ${pin} is already ${taken.name}`);
}

// Adds boxes, all or none.
export async function createBoxes(db: Db, boxes: BoxInput[]) {
	return db.transaction(async (tx) => {
		const saved = [];
		for (const box of boxes) {
			const values = boxValues(box);
			if (box.pin !== undefined) await refuseTakenPin(tx, box.pin);
			const [row] = await tx
				.insert(packages)
				.values({ ...values, pin: box.pin ?? (await freePackagePin(tx)) })
				.returning();
			saved.push(row);
		}
		return saved;
	});
}

// Everything about a box can change, its pin included. Past labels keep
// pointing at it.
export async function updateBox(
	db: Db,
	id: number,
	box: BoxInput & { pin: number },
) {
	const values = boxValues(box);
	await refuseTakenPin(db, box.pin, id);
	const [saved] = await db
		.update(packages)
		.set({ ...values, pin: box.pin })
		.where(eq(packages.id, id))
		.returning();
	if (!saved) throw new BoxError("No such box");
	return saved;
}
