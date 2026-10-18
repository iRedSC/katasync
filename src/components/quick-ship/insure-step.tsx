import { useEffect, useRef, useState } from "react";
import { formatMoney } from "#/lib/format";
import { cn } from "#/lib/utils";
import { bigInput } from "./constants";

export function InsureStep({
	total,
	boxes,
	onSubmit,
}: {
	total: number;
	boxes: number;
	onSubmit: (amount: number | null) => void;
}) {
	const [choice, setChoice] = useState(0);
	const [custom, setCustom] = useState(String(Math.round(total)));
	const group = useRef<HTMLDivElement>(null);
	useEffect(() => group.current?.focus(), []);

	const options = [
		{ label: "Order value", value: formatMoney(total) },
		{ label: "Other amount", value: null },
		{ label: "Don't insure", value: null },
	];

	function submit(i = choice) {
		if (i === 0) onSubmit(total);
		if (i === 1 && Number(custom) > 0) onSubmit(Number(custom));
		if (i === 2) onSubmit(null);
	}

	return (
		<div
			ref={group}
			role="listbox"
			aria-label="Insurance"
			tabIndex={0}
			className="flex flex-col gap-2 outline-none"
			onKeyDown={(e) => {
				if (e.key === "ArrowDown") setChoice((c) => Math.min(c + 1, 2));
				if (e.key === "ArrowUp") setChoice((c) => Math.max(c - 1, 0));
				if (e.key === "Enter" && choice !== 1) submit();
			}}
		>
			<p className="text-xl font-semibold">
				{boxes > 1 ? `Insure ${boxes} boxes? Split evenly.` : "Insure?"}
			</p>
			{options.map((o, i) => (
				<button
					key={o.label}
					type="button"
					onMouseMove={() => setChoice(i)}
					onClick={() => (i === 1 ? setChoice(1) : submit(i))}
					className={cn(
						"flex h-16 items-center justify-between rounded-xl border-2 px-5 text-left text-xl",
						choice === i
							? "border-primary bg-primary text-primary-foreground"
							: "border-border hover:bg-subtle",
					)}
				>
					<span>{o.label}</span>
					{o.value && (
						<span className="text-2xl font-bold tabular-nums">{o.value}</span>
					)}
				</button>
			))}
			{choice === 1 && (
				<input
					// biome-ignore lint/a11y/noAutofocus: shown only to type the amount
					autoFocus
					inputMode="decimal"
					value={custom}
					onFocus={(e) => e.target.select()}
					onChange={(e) => setCustom(e.target.value.replace(/[^\d.]/g, ""))}
					onKeyDown={(e) => {
						if (e.key === "Enter") {
							e.stopPropagation();
							submit(1);
						}
					}}
					className={cn(bigInput, "h-20 text-5xl")}
				/>
			)}
		</div>
	);
}
