import { Tag, X } from "lucide-react";
import { type FormEvent, useState } from "react";
import { Button } from "#/components/ui/button";
import {
	Popover,
	PopoverContent,
	PopoverTrigger,
} from "#/components/ui/popover";
import { Tip } from "#/components/ui/tooltip";
import { formatMoney } from "#/lib/format";
import { ids, optimism } from "#/lib/optimism";
import { offerUndo } from "#/lib/undo";
import { cn } from "#/lib/utils";
import {
	coveredUnits,
	type Discount,
	type DiscountOff,
	describeDiscount,
	describeTerms,
	discountProblem,
	discountValues,
	lineCents,
} from "#/purchasing/discount";
import { removeLineDiscount, saveLineDiscount } from "#/server/purchasing";
import { field } from "./inline-fields";
import { patchLines } from "./po-data";
import type { Line } from "./types";

// A line's amount after its discounts, with what they take off under it.
// The tag opens them, to add one or take one off. On a sent PO the supplier
// isn't told; on a draft they print on the PO.
export function AmountCell({
	line,
	purchaseOrderId,
	draft,
	editable,
}: {
	line: Line;
	purchaseOrderId: number;
	draft: boolean;
	editable: boolean;
}) {
	const [open, setOpen] = useState(false);
	const total = lineCents(line, line.discounts);
	const before = lineCents(line, []);
	const has = line.discounts.length > 0;
	const units = coveredUnits(line.quantity, line.discounts);
	const says = line.discounts.map((d, i) =>
		describeDiscount(d, units[i], line.discounts.length > 1),
	);
	return (
		// The tag sits in the cell's left padding, so the amount keeps the
		// column's full width, as it had before discounts.
		<div className="group/amt relative flex flex-col items-end leading-tight">
			{editable && (
				<Popover open={open} onOpenChange={setOpen}>
					<Tip content={has ? says.join(", ") : "Add a discount"}>
						<PopoverTrigger asChild>
							<button
								type="button"
								aria-label={`Discounts on ${line.sku}`}
								className={cn(
									"absolute top-1/2 -left-[1.125rem] flex size-5 -translate-y-1/2 items-center justify-center rounded-md outline-none hover:bg-surface focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-ring",
									has || open
										? "text-success-icon"
										: "text-muted-foreground opacity-0 group-hover/amt:opacity-100",
								)}
							>
								<Tag aria-hidden className="size-3.5" />
							</button>
						</PopoverTrigger>
					</Tip>
					<PopoverContent align="end" className="w-80 p-3">
						<Discounts
							line={line}
							purchaseOrderId={purchaseOrderId}
							draft={draft}
						/>
					</PopoverContent>
				</Popover>
			)}
			<span>{total === null ? "—" : formatMoney(total / 100)}</span>
			{has &&
				total !== null &&
				before !== null &&
				(editable ? (
					<button
						type="button"
						tabIndex={-1}
						onClick={() => setOpen(true)}
						className="cursor-pointer text-xs text-success-text hover:underline"
					>
						−{formatMoney((before - total) / 100)}
					</button>
				) : (
					<span className="text-xs text-success-text">
						−{formatMoney((before - total) / 100)}
					</span>
				))}
		</div>
	);
}

// What's in the tag's popover: the line's discounts, each with a way to take
// it off, and a form to add one. "All" covers every unit no other discount
// does, so it follows the quantity. An amount is for those units together.
// The form says why a discount can't go on before it's sent.
function Discounts({
	line,
	purchaseOrderId,
	draft,
}: {
	line: Line;
	purchaseOrderId: number;
	draft: boolean;
}) {
	const [all, setAll] = useState(
		!line.discounts.some((d) => d.units === "rest"),
	);
	const [unitsText, setUnitsText] = useState("1");
	const [kind, setKind] = useState<DiscountOff["kind"]>("percent");
	const [valueText, setValueText] = useState("");
	const units = coveredUnits(line.quantity, line.discounts);
	const values = discountValues(line, line.discounts);
	const restTaken = line.discounts.some((d) => d.units === "rest");
	const unit = line.packSize === 1 ? "" : ` ${line.unit}`;

	// What the form describes, or why it can't be added.
	const value = Number(valueText.replace(/^\$|%$/g, ""));
	const count = Number(unitsText);
	const draftDiscount: Discount | string =
		valueText.trim() === ""
			? ""
			: !(Number.isFinite(value) && value > 0)
				? `"${valueText}" isn't an amount`
				: kind === "percent" && value > 100
					? "A percent off is at most 100"
					: Math.abs(Math.round(value * 100) - value * 100) > 1e-6
						? kind === "percent"
							? "A percent off has at most 2 decimals"
							: "An amount off is in whole cents"
						: !all && !(Number.isInteger(count) && count > 0)
							? `"${unitsText}" isn't a number of units`
							: {
									units: all ? "rest" : count,
									off:
										kind === "percent"
											? { kind, percent: value }
											: { kind, amount: value },
								};
	const problem =
		typeof draftDiscount === "string"
			? draftDiscount
			: discountProblem(line, [...line.discounts, draftDiscount]);
	const adding = typeof draftDiscount === "string" ? null : draftDiscount;

	function add(e: FormEvent) {
		e.preventDefault();
		if (!adding || problem) return;
		const id = ids.provisional();
		const shown = describeTerms(adding);
		setValueText("");
		setAll(false);
		optimism
			.change({
				label: `Discount on ${line.sku}`,
				patch: discountsPatch(purchaseOrderId, line, draft, (ds) => [
					...ds,
					{ id, units: adding.units, off: adding.off, receiptId: null },
				]),
				send: async () => {
					const r = await saveLineDiscount({
						data: { lineId: ids.server(line.id), discount: adding },
					});
					ids.confirm(id, r.id);
					return r;
				},
			})
			.then(
				(r) =>
					r &&
					offerUndo(`${shown} on ${line.sku}`, {
						undo: async () =>
							(await takeOffDiscount(line, id, purchaseOrderId, draft)) &&
							`Took ${shown} off ${line.sku}`,
					}),
			);
	}

	return (
		<div className="flex flex-col gap-3">
			<p className="font-medium">
				Discounts on {line.sku}
				<span className="block text-xs font-normal text-muted-foreground">
					{draft
						? "They print on the PO."
						: "The supplier isn't told; the PO as sent stays as it was."}
				</span>
			</p>
			{line.discounts.length > 0 && (
				<ul className="flex flex-col gap-1">
					{line.discounts.map((d, i) => (
						<li key={d.id} className="flex items-center gap-2">
							<span className="min-w-0 flex-1 truncate">
								{describeDiscount(d, units[i], line.discounts.length > 1)}
								{d.receiptId !== null && (
									<span className="text-muted-foreground">
										{" "}
										· in a delivery
									</span>
								)}
							</span>
							<span className="text-success-text tabular-nums">
								{values[i] === null ? "—" : `−${formatMoney(values[i])}`}
							</span>
							<button
								type="button"
								aria-label={`Take ${describeTerms(d)} off`}
								onClick={() => {
									const shown = describeTerms(d);
									takeOffDiscount(line, d.id, purchaseOrderId, draft).then(
										(r) =>
											r &&
											offerUndo(`Took ${shown} off ${line.sku}`, {
												undo: async () => {
													const again = ids.provisional();
													const back = await optimism.change({
														label: `Putting ${shown} back on ${line.sku}`,
														patch: discountsPatch(
															purchaseOrderId,
															line,
															draft,
															(ds) => [...ds, { ...d, id: again }],
														),
														send: async () => {
															const saved = await saveLineDiscount({
																data: {
																	lineId: ids.server(line.id),
																	discount: { units: d.units, off: d.off },
																	// One from a delivery stays with it.
																	...(d.receiptId !== null
																		? { receiptId: ids.server(d.receiptId) }
																		: {}),
																},
															});
															ids.confirm(again, saved.id);
														},
													});
													return back && `${shown} back on ${line.sku}`;
												},
											}),
									);
								}}
								className="flex size-6 items-center justify-center rounded-md text-muted-foreground hover:bg-surface hover:text-foreground"
							>
								<X aria-hidden className="size-3.5" />
							</button>
						</li>
					))}
				</ul>
			)}
			<form onSubmit={add} className="flex flex-col gap-2 border-t pt-3">
				<div className="flex items-center gap-2">
					<fieldset
						aria-label="Discount kind"
						className="flex rounded-lg bg-surface p-0.5"
					>
						{(["percent", "amount"] as const).map((k) => (
							<button
								key={k}
								type="button"
								aria-pressed={kind === k}
								onClick={() => setKind(k)}
								className={cn(
									"h-7 w-8 rounded-md font-semibold",
									kind === k ? "bg-white shadow-card" : "text-muted-foreground",
								)}
							>
								{k === "percent" ? "%" : "$"}
							</button>
						))}
					</fieldset>
					<input
						value={valueText}
						onChange={(e) => setValueText(e.target.value)}
						inputMode="decimal"
						placeholder={kind === "percent" ? "10" : "12.00"}
						aria-label={kind === "percent" ? "Percent off" : "Dollars off"}
						// biome-ignore lint/a11y/noAutofocus: the popover opens to add one
						autoFocus
						className={cn(field, "w-20")}
					/>
					<span className="text-muted-foreground">off</span>
				</div>
				<div className="flex items-center gap-2">
					<input
						value={
							all
								? String(Math.max(line.quantity - fixedOf(line.discounts), 0))
								: unitsText
						}
						onChange={(e) => setUnitsText(e.target.value)}
						disabled={all}
						inputMode="numeric"
						aria-label="Units it covers"
						className={cn(
							field,
							"w-16 disabled:bg-surface disabled:text-muted-foreground",
						)}
					/>
					<span className="text-muted-foreground">{unit || " units"}</span>
					<label
						className={cn(
							"ml-auto flex items-center gap-1.5",
							restTaken && "text-muted-foreground",
						)}
					>
						<input
							type="checkbox"
							checked={all}
							disabled={restTaken}
							onChange={(e) => setAll(e.target.checked)}
						/>
						{line.discounts.length > 0 ? "All the rest" : "All"}
					</label>
				</div>
				<p className="text-xs text-muted-foreground">
					{kind === "amount"
						? "Dollars off those units together, not each."
						: all
							? "Follows the quantity as it changes."
							: "100% is free."}
				</p>
				{problem && <p className="text-xs text-critical-text">{problem}</p>}
				<Button
					type="submit"
					size="sm"
					disabled={!adding || problem !== null}
					className="self-end"
				>
					Add discount
				</Button>
			</form>
		</div>
	);
}

const fixedOf = (discounts: Discount[]) =>
	discounts.reduce((n, d) => n + (d.units === "rest" ? 0 : d.units), 0);

// Changes a line's discounts. A draft's lines match by product, as its other
// patches do.
const discountsPatch = (
	purchaseOrderId: number,
	line: Line,
	draft: boolean,
	change: (ds: Line["discounts"]) => Line["discounts"],
) =>
	patchLines(
		purchaseOrderId,
		(l) => (draft ? l.productId === line.productId : l.id === line.id),
		(l) => ({ ...l, discounts: change(l.discounts) }),
		{ draftEdit: draft },
	);

// Takes one of a line's discounts off. Resolves to null when it failed and
// said why.
function takeOffDiscount(
	line: Line,
	id: number,
	purchaseOrderId: number,
	draft: boolean,
) {
	return optimism.change({
		label: `Taking a discount off ${line.sku}`,
		patch: discountsPatch(purchaseOrderId, line, draft, (ds) =>
			ds.filter((x) => !ids.same(x.id, id)),
		),
		send: () => removeLineDiscount({ data: { id: ids.server(id) } }),
	});
}
