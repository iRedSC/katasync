import { useEffect, useRef, useState } from "react";
import { Badge } from "#/components/page";
import { Truncate } from "#/components/truncate";
import { formatMoney } from "#/lib/format";
import { cn } from "#/lib/utils";
import type { Rate } from "#/shipping/shippo";
import { Notice } from "./notice";
import { Spinner } from "./spinner";
import type { Rates } from "./types";

export function RatesStep({
	rates,
	boxes,
	busy,
	onBuy,
}: {
	rates: Rates | null;
	boxes: number;
	busy: boolean;
	onBuy: (quote: Rate) => void;
}) {
	const [selected, setSelected] = useState(0);
	// New prices start from the top, so the choice is always in the list.
	// biome-ignore lint/correctness/useExhaustiveDependencies: reset on each new list
	useEffect(() => setSelected(0), [rates]);
	const list = useRef<HTMLDivElement>(null);
	const options = useRef<HTMLDivElement>(null);
	useEffect(() => {
		if (rates) list.current?.focus();
	}, [rates]);
	// Only five services fit; keep the arrow-key choice visible as it scrolls.
	// Hover also selects, so scrolling here (not on every change) keeps the list still under the mouse.
	function moveTo(i: number) {
		setSelected(i);
		options.current?.children[i]?.scrollIntoView({ block: "nearest" });
	}

	if (!rates) {
		return (
			<div className="flex h-40 items-center justify-center gap-3 text-xl text-muted-foreground">
				<Spinner /> Getting prices
			</div>
		);
	}
	if (rates.list.length === 0) {
		return (
			<Notice tone="critical">
				{boxes > 1
					? "No service ships every one of these boxes."
					: "No services available."}
				{rates.notes.length > 0 && ` ${rates.notes.join(" ")}`}
			</Notice>
		);
	}
	return (
		<div
			ref={list}
			role="listbox"
			aria-label="Services"
			tabIndex={0}
			className="flex flex-col gap-2 outline-none"
			onKeyDown={(e) => {
				if (e.key === "ArrowDown") {
					e.preventDefault();
					moveTo(Math.min(selected + 1, rates.list.length - 1));
				}
				if (e.key === "ArrowUp") {
					e.preventDefault();
					moveTo(Math.max(selected - 1, 0));
				}
				const quote = rates.list[selected];
				if (e.key === "Enter" && quote) onBuy(quote);
			}}
		>
			<div className="flex items-baseline justify-between">
				<p className="text-xl font-semibold">
					{boxes > 1
						? busy
							? `Buying ${boxes} labels…`
							: `Enter buys ${boxes} labels, one per box`
						: busy
							? "Buying label…"
							: "Enter buys the label"}
				</p>
				{rates.test && <Badge tone="info">Test labels</Badge>}
			</div>
			<div
				ref={options}
				className="flex max-h-[22rem] flex-col gap-2 overflow-y-auto"
			>
				{rates.list.map((r, i) => (
					<button
						key={r.id}
						type="button"
						disabled={busy}
						onMouseMove={() => setSelected(i)}
						onClick={() => onBuy(r)}
						className={cn(
							"flex h-16 shrink-0 items-center justify-between rounded-xl border-2 px-5 text-left",
							i === selected
								? "border-primary bg-primary text-primary-foreground"
								: "border-border hover:bg-subtle",
							busy && i !== selected && "opacity-40",
						)}
					>
						<span className="min-w-0">
							<Truncate
								text={r.serviceName}
								className="text-lg font-semibold"
							/>
							{r.days !== null && (
								<span
									className={
										i === selected ? "text-white/70" : "text-muted-foreground"
									}
								>
									{r.days} {r.days === 1 ? "day" : "days"}
								</span>
							)}
						</span>
						<span className="flex items-center gap-3 text-3xl font-bold tabular-nums">
							{busy && i === selected && <Spinner />}
							{formatMoney(r.cost)}
						</span>
					</button>
				))}
			</div>
		</div>
	);
}
