import { formatMoney } from "#/lib/format";
import { cn } from "#/lib/utils";
import type { ShipmentPlan } from "#/shipping/quick-ship";
import type { Bought, Box, Dims, Found, Packed, Step } from "./types";
import { ounces, size } from "./units";

export type StepItem = { id: Step; label: string; value: string | null };

// The strip's label and value for each step, from the choices so far.
export function stepsFor({
	found,
	plan,
	step,
	packed,
	box,
	dims,
	weightGrams,
	insureAmount,
	bought,
	count,
}: {
	found: Found | null;
	plan: ShipmentPlan | null;
	step: Step;
	packed: Packed[];
	box: Box | null;
	dims: Dims | null;
	weightGrams: number | null;
	insureAmount: number | null;
	bought: Bought | null;
	count: number;
}): StepItem[] {
	const external = found?.external ?? null;
	return external
		? [
				{ id: "pin", label: "Order", value: found?.order.name ?? null },
				{ id: "package", label: "Ship on", value: external.name },
			]
		: [
				{
					id: "pin",
					label: plan && plan.orderIds.length > 1 ? "Orders" : "Order",
					value: plan?.orderNames.join(" + ") ?? null,
				},
				{
					id: "package",
					label: packed.length > 0 ? `Box ${packed.length + 1}` : "Box",
					value:
						packed.length > 0 && step !== "package" && step !== "weight"
							? `${count} boxes`
							: box
								? box.name
								: dims
									? `${size(dims)} in`
									: null,
				},
				{
					id: "weight",
					label: "Weight",
					value: weightGrams
						? packed.length > 0 && step !== "weight"
							? `${ounces(packed.reduce((g, p) => g + p.weightGrams, weightGrams))} oz total`
							: `${ounces(weightGrams)} oz`
						: null,
				},
				...(plan?.insure
					? [
							{
								id: "insure" as const,
								label: "Insurance",
								value:
									step === "insure" || !weightGrams
										? null
										: insureAmount
											? formatMoney(insureAmount)
											: "None",
							},
						]
					: []),
				{ id: "rates", label: "Service", value: bought?.serviceName ?? null },
			];
}

// Every choice so far, big enough to check from arm's length.
export function StepStrip({
	steps,
	current,
}: {
	steps: { id: Step; label: string; value: string | null }[];
	current: Step;
}) {
	return (
		<ol className="grid auto-cols-fr grid-flow-col border-b bg-subtle">
			{steps.map((s) => {
				const active = s.id === current;
				return (
					<li
						key={s.id}
						className={cn(
							"min-w-0 border-b-4 px-4 pt-3 pb-2",
							// Marketplace order numbers run long; the order gets two shares.
							s.id === "pin" && "col-span-2",
							active ? "border-primary bg-white" : "border-transparent",
						)}
					>
						<div className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
							{s.label}
						</div>
						<div
							className={cn(
								"truncate text-lg font-semibold",
								!s.value && "text-faint",
							)}
						>
							{s.value ?? "—"}
						</div>
					</li>
				);
			})}
		</ol>
	);
}
