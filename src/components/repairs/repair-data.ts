import { ids, optimism, optimistic } from "#/lib/optimism";
import type { getRepairDetail } from "#/server/repairs";
import {
	addRepairLabor,
	addRepairTool,
	changeRepair,
	changeRepairLabor,
	changeRepairTool,
	removeRepairLabor,
	removeRepairTool,
	restoreRepairTool,
	setRepairPart,
} from "#/server/repairs";

// One repair's page data, and the changes that show on it at once. Prices
// come from Shopify, so they settle when the page reloads after each one.
// Labor and parts are on one of its tools, or on the order as a whole
// (toolId null).

export type Detail = Awaited<ReturnType<typeof getRepairDetail>>;
export type Tool = Detail["tools"][number];
export type RemovedTool = Awaited<ReturnType<typeof removeRepairTool>>;
export const repairData = optimistic<Detail>("repair");
export type RepairActions = ReturnType<typeof repairActions>;

// A tool id to send: null stays null, the order as a whole.
const sendable = (toolId: number | null) =>
	toolId === null ? null : ids.server(toolId);
const sameTool = (a: number | null, b: number | null) =>
	a === null || b === null ? a === b : ids.same(a, b);

export function repairActions(d: Detail) {
	const id = d.repair.id;
	const patch = (apply: (x: Detail) => Detail) => repairData.patch(id, apply);
	return {
		edit(
			label: string,
			edit: Omit<Parameters<typeof changeRepair>[0]["data"], "id">,
			shown: Partial<Detail["repair"]>,
		) {
			return optimism.change({
				label,
				patch: patch((x) => ({ ...x, repair: { ...x.repair, ...shown } })),
				send: () => changeRepair({ data: { id, ...edit } }),
			});
		},
		addTool(fields: { tool: string; productId: number | null }) {
			const toolId = ids.provisional();
			return optimism.change({
				label: "The tool",
				patch: patch((x) => ({
					...x,
					tools: [
						...x.tools,
						{
							id: toolId,
							serial: null,
							problem: "",
							imageUrl: null,
							...fields,
						},
					],
				})),
				send: async () => {
					const r = await addRepairTool({ data: { id, fields } });
					ids.confirm(toolId, r.toolId);
					return r;
				},
			});
		},
		editTool(
			toolId: number,
			edit: {
				tool?: string;
				productId?: number | null;
				serial?: string | null;
				problem?: string;
			},
		) {
			return optimism.change({
				label: "The tool",
				patch: patch((x) => ({
					...x,
					tools: x.tools.map((t) =>
						ids.same(t.id, toolId) ? { ...t, ...edit } : t,
					),
				})),
				send: () =>
					changeRepairTool({
						data: { id, toolId: ids.server(toolId), ...edit },
					}),
			});
		},
		// Takes the tool off with its labor and parts; resolves to what came
		// off, to put back.
		removeTool(toolId: number) {
			const gone = (t: number | null) => t !== null && ids.same(t, toolId);
			return optimism.change({
				label: "Taking the tool off",
				patch: patch((x) => ({
					...x,
					tools: x.tools.filter((t) => !ids.same(t.id, toolId)),
					labor: x.labor.filter((l) => !gone(l.toolId)),
					parts: x.parts.filter((p) => !gone(p.toolId)),
				})),
				send: () =>
					removeRepairTool({ data: { id, toolId: ids.server(toolId) } }),
			});
		},
		restoreTool(removed: RemovedTool) {
			return optimism.change({
				send: () => restoreRepairTool({ data: { id, removed } }),
			});
		},
		addLabor(toolId: number | null, minutes: number, note: string) {
			const laborId = ids.provisional();
			return optimism.change({
				label: "The time",
				patch: patch((x) => ({
					...x,
					labor: [
						...x.labor,
						{ id: laborId, toolId, minutes, note, createdAt: new Date() },
					],
				})),
				send: async () => {
					const r = await addRepairLabor({
						data: { id, toolId: sendable(toolId), minutes, note },
					});
					ids.confirm(laborId, r.laborId);
					return r;
				},
			});
		},
		editLabor(laborId: number, edit: { minutes?: number; note?: string }) {
			return optimism.change({
				label: "The time",
				patch: patch((x) => ({
					...x,
					labor: x.labor.map((l) =>
						ids.same(l.id, laborId) ? { ...l, ...edit } : l,
					),
				})),
				send: () =>
					changeRepairLabor({
						data: { id, laborId: ids.server(laborId), ...edit },
					}),
			});
		},
		removeLabor(laborId: number) {
			return optimism.change({
				label: "Taking the time off",
				patch: patch((x) => ({
					...x,
					labor: x.labor.filter((l) => !ids.same(l.id, laborId)),
				})),
				send: () =>
					removeRepairLabor({ data: { id, laborId: ids.server(laborId) } }),
			});
		},
		setPart(
			toolId: number | null,
			part: Pick<
				Detail["parts"][number],
				"productId" | "sku" | "name" | "variantName" | "imageUrl"
			>,
			quantity: number,
		) {
			const here = (p: Detail["parts"][number]) =>
				p.productId === part.productId && sameTool(p.toolId, toolId);
			return optimism.change({
				label: `${part.sku}`,
				patch: patch((x) => {
					const has = x.parts.some(here);
					const parts =
						quantity === 0
							? x.parts.filter((p) => !here(p))
							: has
								? x.parts.map((p) =>
										here(p)
											? {
													...p,
													quantity,
													charged: p.charged && {
														each: p.charged.each,
														total: p.charged.each * quantity,
													},
												}
											: p,
									)
								: [
										...x.parts,
										{
											...part,
											toolId,
											quantity,
											onShopify: true,
											unitCost: null,
											onHand: null,
											charged: null,
										},
									];
					return { ...x, parts };
				}),
				send: () =>
					setRepairPart({
						data: {
							id,
							toolId: sendable(toolId),
							productId: part.productId,
							quantity,
						},
					}),
			});
		},
	};
}
