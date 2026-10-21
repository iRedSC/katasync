import { Check } from "lucide-react";
import { type FormEvent, type ReactNode, useEffect, useState } from "react";
import { Button } from "#/components/ui/button";
import {
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "#/components/ui/dialog";
import { Tip } from "#/components/ui/tooltip";
import { formatCount } from "#/lib/format";
import { cn } from "#/lib/utils";
import type { RefurbishOptions } from "#/orders/refurbish";
import { getRefurbishOptions } from "#/server/orders";

// What a refurb becomes, chosen at the bench: its condition (the shop's
// own, in its colors), and either a new Shopify draft (title and price,
// copied from what it was) or an existing refurb of it in that condition.
export type RefurbChoice =
	| { kind: "new"; condition: string; title: string; price: number }
	| { kind: "add"; productId: number; sku: string };

const input =
	"h-8 w-full rounded-lg border border-input bg-white px-2 outline-none focus:border-ring";

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
	const [condition, setCondition] = useState<string | null>(null);
	const [into, setInto] = useState<number | "new">("new");
	const [title, setTitle] = useState("");
	const [price, setPrice] = useState("");

	useEffect(() => {
		let live = true;
		getRefurbishOptions({ data: { orderId, lineId } }).then(
			(o) => {
				if (!live) return;
				setOptions(o);
				setTitle(o.title);
				setPrice(o.price.toFixed(2));
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
			<div className="flex flex-col gap-6">
				{header}
				<div className="flex flex-wrap gap-2">
					{[0, 1, 2, 3].map((i) => (
						<div
							key={i}
							className="h-8 w-24 animate-pulse rounded-full bg-subtle"
						/>
					))}
				</div>
				<div className="h-8 animate-pulse rounded-lg bg-subtle" />
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

	const same = options.existing.filter((e) => e.condition === condition);
	const target = same.find((e) => e.id === into);
	const amount = Number(price);
	const ready =
		condition !== null &&
		(target !== undefined || (title.trim() !== "" && amount > 0));

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
		if (!ready || condition === null) return;
		onChoose(
			target
				? { kind: "add", productId: target.id, sku: target.sku }
				: { kind: "new", condition, title: title.trim(), price: amount },
		);
	}

	return (
		<form onSubmit={submit} className="flex min-w-0 flex-col gap-6">
			{header}
			<fieldset className="flex flex-wrap gap-2" aria-label="Condition">
				{options.conditions.map((c) => {
					const chosen = c.handle === condition;
					const chip = (
						<button
							key={c.handle}
							type="button"
							aria-pressed={chosen}
							onClick={() => pick(c.handle)}
							style={
								chosen && c.color
									? { backgroundColor: c.color, borderColor: c.color }
									: undefined
							}
							className={cn(
								"inline-flex h-8 items-center gap-1.5 rounded-full border px-3 transition-colors",
								chosen ? "text-white" : "hover:bg-subtle",
							)}
						>
							{!chosen && (
								<span
									className="size-2.5 rounded-full"
									style={{ backgroundColor: c.color ?? "currentColor" }}
								/>
							)}
							{c.label}
						</button>
					);
					return c.description ? (
						<Tip key={c.handle} content={c.description}>
							{chip}
						</Tip>
					) : (
						chip
					);
				})}
			</fieldset>

			{same.length > 0 && (
				<div className="flex flex-wrap gap-2">
					{same.map((e) => (
						<Choice
							key={e.id}
							chosen={into === e.id}
							onClick={() => setInto(e.id)}
						>
							Add to {e.sku}
							<span className="text-muted-foreground">
								{formatCount(e.onHand)} on shelf
							</span>
						</Choice>
					))}
					<Choice chosen={into === "new"} onClick={() => setInto("new")}>
						New {options.sku}
					</Choice>
				</div>
			)}

			{!target && (
				<div className="grid grid-cols-[1fr_8rem] gap-3">
					<label className="flex flex-col gap-1">
						<span className="text-muted-foreground">Title</span>
						<input
							value={title}
							onChange={(e) => setTitle(e.target.value)}
							className={input}
						/>
					</label>
					<label className="flex flex-col gap-1">
						<span className="text-muted-foreground">Price</span>
						<input
							inputMode="decimal"
							value={price}
							onChange={(e) => setPrice(e.target.value.replace(/[^\d.]/g, ""))}
							className={cn(input, "tabular-nums")}
						/>
					</label>
				</div>
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

function Choice({
	chosen,
	onClick,
	children,
}: {
	chosen: boolean;
	onClick: () => void;
	children: ReactNode;
}) {
	return (
		<button
			type="button"
			aria-pressed={chosen}
			onClick={onClick}
			className={cn(
				"inline-flex h-8 items-center gap-1.5 rounded-lg border px-3",
				chosen ? "border-ring bg-surface font-medium" : "hover:bg-subtle",
			)}
		>
			{chosen && <Check className="size-4" />}
			{children}
		</button>
	);
}
