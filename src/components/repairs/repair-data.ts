import { ids, optimism, optimistic } from "#/lib/optimism";
import type { getRepairDetail } from "#/server/repairs";
import {
	addRepairLabor,
	changeRepair,
	changeRepairLabor,
	removeRepairLabor,
	setRepairPart,
} from "#/server/repairs";

// One repair's page data, and the changes that show on it at once. Prices
// come from Shopify, so they settle when the page reloads after each one.

export type Detail = Awaited<ReturnType<typeof getRepairDetail>>;
export const repairData = optimistic<Detail>("repair");

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
		addLabor(minutes: number, note: string) {
			const laborId = ids.provisional();
			return optimism.change({
				label: "The time",
				patch: patch((x) => ({
					...x,
					labor: [
						...x.labor,
						{ id: laborId, minutes, note, createdAt: new Date() },
					],
				})),
				send: async () => {
					const r = await addRepairLabor({ data: { id, minutes, note } });
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
			part: Pick<
				Detail["parts"][number],
				"productId" | "sku" | "name" | "variantName" | "imageUrl"
			>,
			quantity: number,
		) {
			return optimism.change({
				label: `${part.sku}`,
				patch: patch((x) => {
					const has = x.parts.some((p) => p.productId === part.productId);
					const parts =
						quantity === 0
							? x.parts.filter((p) => p.productId !== part.productId)
							: has
								? x.parts.map((p) =>
										p.productId === part.productId ? { ...p, quantity } : p,
									)
								: [...x.parts, { ...part, quantity, onShopify: true }];
					return { ...x, parts };
				}),
				send: () =>
					setRepairPart({ data: { id, productId: part.productId, quantity } }),
			});
		},
	};
}
