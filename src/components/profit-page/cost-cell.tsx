import { Link } from "@tanstack/react-router";
import { useCallback, useRef, useState } from "react";
import { toast } from "sonner";
import { MatchDialog } from "#/components/match-picker";
import { Tip } from "#/components/ui/tooltip";
import { formatMoney } from "#/lib/format";
import { optimism } from "#/lib/optimism";
import { setProductCost } from "#/server/profit";
import type { Item } from "./item";
import { itemsData } from "./items-store";

// A known cost shows as it is: a sale keeps what its product cost when it
// came in, so changing the product's cost wouldn't change it. A sale with no
// cost can be given one, which fills in every sale of the product without one.
export function Cost({ item: i, range }: { item: Item; range: string }) {
	const [editing, setEditing] = useState(false);
	const [value, setValue] = useState("");
	const [matching, setMatching] = useState(false);
	const closeMatch = useCallback(() => setMatching(false), []);
	// Escape closes without saving what was typed.
	const cancelled = useRef(false);

	if (i.costKnown) return <>{formatMoney(i.cost)}</>;
	if (i.productId === null && !i.awaitsMatch)
		return <span className="text-muted-foreground">Custom</span>;
	if (i.productId === null)
		return (
			<>
				<button
					type="button"
					onClick={() => setMatching(true)}
					className="text-critical-text hover:underline"
				>
					No product
				</button>
				<MatchDialog
					orderId={matching ? i.orderId : null}
					onClose={closeMatch}
				/>
			</>
		);
	if (i.productKind === "bundle")
		return (
			<Tip content="A tool set costs its parts; one of them has no cost">
				<Link
					to="/products/$sku"
					params={{ sku: i.sku ?? "" }}
					className="text-critical-text hover:underline"
				>
					A part has no cost
				</Link>
			</Tip>
		);
	if (!editing)
		return (
			<button
				type="button"
				onClick={() => {
					setValue("");
					cancelled.current = false;
					setEditing(true);
				}}
				className="rounded px-1.5 py-0.5 font-semibold text-critical-text hover:bg-surface"
			>
				Set cost
			</button>
		);

	const productId = i.productId;
	const sku = i.sku;
	async function save() {
		const unitCost = Number(value);
		if (cancelled.current || value.trim() === "") return setEditing(false);
		if (!Number.isFinite(unitCost) || unitCost < 0) {
			toast.error(`"${value}" isn't a cost`);
			return;
		}
		setEditing(false);
		const r = await optimism.change({
			label: `Setting ${sku}'s cost`,
			patch: itemsData.patch(range, (list) =>
				list.map((x) => {
					if (x.productId !== productId || x.costKnown) return x;
					// As the view counts it: units back on the shelf, or on
					// their way, cost nothing.
					const cost = unitCost * (x.quantity - x.restocked - x.returning);
					return {
						...x,
						cost,
						costKnown: true,
						profit: x.profit - cost,
						complete:
							x.feesStatus !== "estimated" &&
							(x.labelsStatus === "known" || x.labelsStatus === "not_needed") &&
							x.returning === 0,
					};
				}),
			),
			send: () => setProductCost({ data: { productId, unitCost } }),
		});
		if (r)
			toast.success(`${sku} costs ${formatMoney(unitCost)} each`, {
				description: "Every sale of it without a cost now uses this.",
			});
	}

	return (
		<input
			// biome-ignore lint/a11y/noAutofocus: opened by clicking "Set cost"
			autoFocus
			inputMode="decimal"
			value={value}
			onChange={(e) => setValue(e.target.value)}
			onKeyDown={(e) => {
				if (e.key === "Enter") e.currentTarget.blur();
				else if (e.key === "Escape") {
					cancelled.current = true;
					e.currentTarget.blur();
				}
			}}
			onBlur={save}
			placeholder="Each"
			aria-label={`Cost of one ${sku}`}
			className="h-7 w-20 rounded-md border border-input px-2 text-right outline-none focus:border-ring focus:ring-1 focus:ring-ring"
		/>
	);
}
