import { type FormEvent, type ReactNode, useEffect, useState } from "react";
import { Button } from "#/components/ui/button";
import {
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "#/components/ui/dialog";
import { formatCount } from "#/lib/format";
import { cn } from "#/lib/utils";
import type { RefurbDetails, RefurbishOptions } from "#/orders/refurbish";
import { getRefurbishOptions } from "#/server/orders";

// What a refurb becomes, chosen at the bench: its condition (the shop's
// own), and either a new Shopify draft, starting from everything the
// original's listing says, or more of an existing refurb in that condition.
export type RefurbChoice =
	| ({ kind: "new" } & RefurbDetails)
	| { kind: "add"; productId: number; sku: string };

const input =
	"h-8 w-full rounded-lg border border-input bg-white px-2 outline-none focus:border-ring aria-invalid:border-destructive";

const GRAMS_PER_LB = 453.592;

// A number typed in a field, or null when it's empty.
const amount = (text: string) =>
	text.trim() === "" ? null : Number(text.replace(/[^\d.]/g, ""));

export function RefurbishForm({
	orderId,
	lineId,
	quantity,
	name,
	onBack,
	onChoose,
}: {
	orderId: number;
	lineId: number;
	quantity: number;
	name: string;
	onBack: () => void;
	onChoose: (choice: RefurbChoice) => void;
}) {
	const [options, setOptions] = useState<
		RefurbishOptions | { error: string } | null
	>(null);
	const [condition, setCondition] = useState("");
	const [into, setInto] = useState<number | "new">("new");
	const [form, setForm] = useState({
		title: "",
		price: "",
		compareAt: "",
		weight: "",
		vendor: "",
		productType: "",
		tags: "",
		notes: "",
	});
	const field =
		(key: keyof typeof form) => (e: { target: { value: string } }) =>
			setForm((f) => ({ ...f, [key]: e.target.value }));

	useEffect(() => {
		let live = true;
		getRefurbishOptions({ data: { orderId, lineId } }).then(
			(o) => {
				if (!live) return;
				setOptions(o);
				const d = o.details;
				setForm({
					title: d.title,
					price: d.price.toFixed(2),
					compareAt: d.compareAtPrice?.toFixed(2) ?? "",
					weight:
						d.weightGrams === null
							? ""
							: String(Math.round((d.weightGrams / GRAMS_PER_LB) * 100) / 100),
					vendor: d.vendor,
					productType: d.productType,
					tags: d.tags.join(", "),
					notes: d.notes,
				});
			},
			(error) =>
				live &&
				setOptions({
					error: error instanceof Error ? error.message : String(error),
				}),
		);
		return () => {
			live = false;
		};
	}, [orderId, lineId]);

	const header = (
		<DialogHeader>
			<DialogTitle>
				Refurbish {formatCount(quantity)} × {name}
			</DialogTitle>
		</DialogHeader>
	);
	const back = (
		<Button type="button" variant="outline" onClick={onBack}>
			Back
		</Button>
	);
	if (!options)
		return (
			<div className="flex flex-col gap-4">
				{header}
				{[0, 1, 2, 3].map((i) => (
					<div key={i} className="h-8 animate-pulse rounded-lg bg-subtle" />
				))}
				<DialogFooter>{back}</DialogFooter>
			</div>
		);
	if ("error" in options)
		return (
			<div className="flex flex-col gap-6">
				{header}
				<p className="text-warning-text">{options.error}</p>
				<DialogFooter>{back}</DialogFooter>
			</div>
		);

	const chosen = options.conditions.find((c) => c.handle === condition);
	const same = options.existing.filter((e) => e.condition === condition);
	const target = same.find((e) => e.id === into);
	const price = amount(form.price);
	const compareAt = amount(form.compareAt);
	const weight = amount(form.weight);
	const priceBad = !(price !== null && price > 0);
	const compareBad =
		compareAt !== null && !(price !== null && compareAt > price);
	const weightBad = weight !== null && !(weight > 0);
	const ready =
		chosen !== undefined &&
		(target !== undefined ||
			(form.title.trim() !== "" && !priceBad && !compareBad && !weightBad));

	function pick(handle: string) {
		setCondition(handle);
		// More of the same goes with what's already listed.
		const first =
			options && !("error" in options)
				? options.existing.find((e) => e.condition === handle)
				: undefined;
		setInto(first?.id ?? "new");
	}

	function submit(e: FormEvent) {
		e.preventDefault();
		if (!ready || !chosen || price === null) return;
		onChoose(
			target
				? { kind: "add", productId: target.id, sku: target.sku }
				: {
						kind: "new",
						condition: chosen.handle,
						title: form.title.trim(),
						price,
						compareAtPrice: compareAt,
						weightGrams:
							weight === null ? null : Math.round(weight * GRAMS_PER_LB),
						vendor: form.vendor,
						productType: form.productType,
						tags: form.tags.split(","),
						notes: form.notes,
					},
		);
	}

	return (
		<form onSubmit={submit} className="flex min-w-0 flex-col gap-4">
			{header}
			<div className="grid grid-cols-2 gap-3">
				<Field label="Condition">
					<div className="relative">
						<span
							className="pointer-events-none absolute top-1/2 left-2.5 size-2.5 -translate-y-1/2 rounded-full transition-colors"
							style={{ backgroundColor: chosen?.color ?? "transparent" }}
						/>
						<select
							// biome-ignore lint/a11y/noAutofocus: the first choice at the bench
							autoFocus
							value={condition}
							onChange={(e) => pick(e.target.value)}
							title={chosen?.description ?? undefined}
							className={cn(input, chosen && "pl-7")}
						>
							<option value="" disabled>
								Choose…
							</option>
							{options.conditions.map((c) => (
								<option key={c.handle} value={c.handle}>
									{c.label}
								</option>
							))}
						</select>
					</div>
				</Field>
				{same.length > 0 && (
					<Field label="Into">
						<select
							value={into}
							onChange={(e) =>
								setInto(
									e.target.value === "new" ? "new" : Number(e.target.value),
								)
							}
							className={input}
						>
							{same.map((e) => (
								<option key={e.id} value={e.id}>
									{e.sku} ({formatCount(e.onHand)} on shelf)
								</option>
							))}
							<option value="new">New {options.sku}</option>
						</select>
					</Field>
				)}
			</div>

			{!target && (
				<>
					<Field label="Title">
						<input
							value={form.title}
							onChange={field("title")}
							aria-invalid={form.title.trim() === ""}
							className={input}
						/>
					</Field>
					<div className="grid grid-cols-3 gap-3">
						<Field label="Price">
							<input
								inputMode="decimal"
								value={form.price}
								onChange={field("price")}
								aria-invalid={priceBad}
								className={cn(input, "tabular-nums")}
							/>
						</Field>
						<Field label="Compare at">
							<input
								inputMode="decimal"
								value={form.compareAt}
								onChange={field("compareAt")}
								aria-invalid={compareBad}
								className={cn(input, "tabular-nums")}
							/>
						</Field>
						<Field label="Weight (lb)">
							<input
								inputMode="decimal"
								value={form.weight}
								onChange={field("weight")}
								aria-invalid={weightBad}
								className={cn(input, "tabular-nums")}
							/>
						</Field>
					</div>
					<div className="grid grid-cols-2 gap-3">
						<Field label="Vendor">
							<input
								value={form.vendor}
								onChange={field("vendor")}
								className={input}
							/>
						</Field>
						<Field label="Type">
							<input
								value={form.productType}
								onChange={field("productType")}
								className={input}
							/>
						</Field>
					</div>
					<Field label="Tags">
						<input
							value={form.tags}
							onChange={field("tags")}
							className={input}
						/>
					</Field>
					<Field label="About this unit">
						<textarea
							value={form.notes}
							onChange={field("notes")}
							rows={3}
							className={cn(input, "h-auto py-1.5")}
						/>
					</Field>
				</>
			)}

			<DialogFooter className="gap-2 sm:justify-between">
				{back}
				<Button type="submit" disabled={!ready}>
					{target ? `Add to ${target.sku}` : `Draft ${options.sku} in Shopify`}
				</Button>
			</DialogFooter>
		</form>
	);
}

function Field({ label, children }: { label: string; children: ReactNode }) {
	return (
		// biome-ignore lint/a11y/noLabelWithoutControl: the control is passed as children
		<label className="flex min-w-0 flex-col gap-1">
			<span className="text-muted-foreground">{label}</span>
			{children}
		</label>
	);
}
