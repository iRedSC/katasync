import { and, asc, eq, sql } from "drizzle-orm";
import type { Db } from "#/db/client";
import { repairLabor, repairParts, repairTools } from "#/db/repair-schema";
import { products } from "#/db/schema";
import { RepairError } from "./draft-sync";
import { withCharges, withRepair } from "./hold";

// The tools on a repair. A customer can leave several on one repair, each
// with its own labor and parts and its own ticket; what's for the order as
// a whole goes on none. A bench job is its one unit.

export type ToolFields = {
	tool: string;
	// The catalog product it is, when picked as one.
	productId?: number | null;
	serial?: string | null;
	problem?: string;
};

const clean = (s: string | null | undefined) => s?.trim() || null;

// The catalog product a tool is, checked to be one.
async function toolProduct(db: Db, id: number | null) {
	if (id === null) return null;
	const [p] = await db
		.select({ id: products.id })
		.from(products)
		.where(eq(products.id, id));
	if (!p) throw new RepairError("That product isn't in the catalog");
	return p.id;
}

// A tool's row, checked and trimmed.
export async function toolValues(db: Db, t: ToolFields) {
	const tool = t.tool.trim();
	if (!tool) throw new RepairError("Say what the tool is");
	return {
		tool,
		productId: await toolProduct(db, t.productId ?? null),
		serial: clean(t.serial),
		problem: t.problem?.trim() ?? "",
	};
}

// Refuses a tool that isn't on this repair. Null, the order as a whole, is
// always there.
export async function checkTool(tx: Db, id: number, toolId: number | null) {
	if (toolId === null) return;
	const [t] = await tx
		.select({ id: repairTools.id })
		.from(repairTools)
		.where(and(eq(repairTools.id, toolId), eq(repairTools.repairId, id)));
	if (!t) throw new RepairError("That tool isn't on this repair");
}

export async function addTool(db: Db, id: number, fields: ToolFields) {
	return withRepair(db, id, async (tx, r) => {
		if (r.kind === "bench")
			throw new RepairError(`R${id} is ours; it's the one tool`);
		const [made] = await tx
			.insert(repairTools)
			.values({ ...(await toolValues(tx, fields)), repairId: id })
			.returning({ id: repairTools.id });
		return made.id;
	});
}

export type ToolEdit = {
	tool?: string;
	// The catalog product it is, or null for one typed out. Goes with the
	// tool: naming it anew without one makes it typed out.
	productId?: number | null;
	serial?: string | null;
	problem?: string;
};

export async function editTool(
	db: Db,
	id: number,
	toolId: number,
	edit: ToolEdit,
) {
	const tool = edit.tool?.trim();
	if (edit.tool !== undefined && !tool)
		throw new RepairError("Say what the tool is");
	if (edit.productId !== undefined && tool === undefined)
		throw new RepairError("Name the tool along with its product");
	await withRepair(db, id, async (tx, r) => {
		await checkTool(tx, id, toolId);
		// A bench job is always the product it came in as.
		if (
			r.kind === "bench" &&
			edit.productId !== undefined &&
			edit.productId !== r.productId
		)
			throw new RepairError(`R${id} is ours; it stays the tool it came in as`);
		const productId =
			r.kind === "customer" && tool !== undefined
				? await toolProduct(tx, edit.productId ?? null)
				: undefined;
		await tx
			.update(repairTools)
			.set({
				...(tool !== undefined && { tool }),
				...(productId !== undefined && { productId }),
				...(edit.serial !== undefined && { serial: clean(edit.serial) }),
				...(edit.problem !== undefined && { problem: edit.problem.trim() }),
			})
			.where(eq(repairTools.id, toolId));
	});
}

// A tool taken off, with its labor and parts, to put back as it was.
export type RemovedTool = Required<ToolFields> & {
	labor: { minutes: number; note: string }[];
	parts: { productId: number; quantity: number }[];
};

// Takes a tool off with its labor and parts. A repair keeps at least one.
export async function removeTool(
	db: Db,
	id: number,
	toolId: number,
): Promise<RemovedTool> {
	return withCharges(db, id, async (tx) => {
		await checkTool(tx, id, toolId);
		const [{ n }] = await tx
			.select({ n: sql<number>`count(*)::int` })
			.from(repairTools)
			.where(eq(repairTools.repairId, id));
		const labor = await tx
			.select({ minutes: repairLabor.minutes, note: repairLabor.note })
			.from(repairLabor)
			.where(and(eq(repairLabor.repairId, id), eq(repairLabor.toolId, toolId)))
			.orderBy(asc(repairLabor.id));
		if (n <= 1) throw new RepairError("A repair keeps at least one tool");
		const parts = await tx
			.select({
				productId: repairParts.productId,
				quantity: repairParts.quantity,
			})
			.from(repairParts)
			.where(and(eq(repairParts.repairId, id), eq(repairParts.toolId, toolId)))
			.orderBy(asc(repairParts.id));
		const [gone] = await tx
			.delete(repairTools)
			.where(and(eq(repairTools.id, toolId), eq(repairTools.repairId, id)))
			.returning({
				tool: repairTools.tool,
				productId: repairTools.productId,
				serial: repairTools.serial,
				problem: repairTools.problem,
			});
		return { ...gone, labor, parts };
	});
}

// Puts a removed tool back, with its labor and parts, as a new tool.
export async function restoreTool(db: Db, id: number, removed: RemovedTool) {
	return withCharges(db, id, async (tx, r) => {
		if (r.kind === "bench")
			throw new RepairError(`R${id} is ours; it's the one tool`);
		const [made] = await tx
			.insert(repairTools)
			.values({ ...(await toolValues(tx, removed)), repairId: id })
			.returning({ id: repairTools.id });
		if (removed.labor.length > 0)
			await tx.insert(repairLabor).values(
				removed.labor.map((l) => ({
					repairId: id,
					toolId: made.id,
					minutes: l.minutes,
					note: l.note,
				})),
			);
		if (removed.parts.length > 0)
			await tx.insert(repairParts).values(
				removed.parts.map((p) => ({
					repairId: id,
					toolId: made.id,
					productId: p.productId,
					quantity: p.quantity,
				})),
			);
		return made.id;
	});
}
