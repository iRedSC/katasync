import { useRouter } from "@tanstack/react-router";
import { type KeyboardEvent, useEffect, useRef, useState } from "react";
import { Badge } from "#/components/page";
import { ProductImage } from "#/components/product";
import { Button } from "#/components/ui/button";
import { Dialog, DialogContent, DialogTitle } from "#/components/ui/dialog";
import { formatMoney } from "#/lib/format";
import { cn } from "#/lib/utils";
import {
	listPackages,
	quickShipBuy,
	quickShipLookup,
	quickShipRates,
} from "#/server/shipping";
import type { Rate } from "#/shipping/shippo";

const MM_PER_INCH = 25.4;
const GRAMS_PER_OUNCE = 28.349523125;

type Found = NonNullable<Awaited<ReturnType<typeof quickShipLookup>>>;
type Box = Awaited<ReturnType<typeof listPackages>>[number];
type Dims = { lengthMm: number; widthMm: number; heightMm: number };
type Step = "pin" | "package" | "weight" | "insure" | "rates" | "done";

const inches = (mm: number) => Math.round((mm / MM_PER_INCH) * 10) / 10;

// Ctrl+Space anywhere: order pin, box pin, weight, (insurance), service.
// Enter moves forward, Escape steps back.
export function QuickShip() {
	const router = useRouter();
	const [open, setOpen] = useState(false);
	const [step, setStep] = useState<Step>("pin");
	const [error, setError] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);
	const [boxes, setBoxes] = useState<Box[]>([]);

	const [found, setFound] = useState<Found | null>(null);
	const [box, setBox] = useState<Box | null>(null);
	const [dims, setDims] = useState<Dims | null>(null);
	const [weightGrams, setWeightGrams] = useState<number | null>(null);
	const [insureAmount, setInsureAmount] = useState<number | null>(null);
	const [rates, setRates] = useState<{
		list: Rate[];
		notes: string[];
		test: boolean;
	} | null>(null);
	const [bought, setBought] = useState<Awaited<
		ReturnType<typeof quickShipBuy>
	> | null>(null);

	function reset() {
		setStep("pin");
		setError(null);
		setFound(null);
		setBox(null);
		setDims(null);
		setWeightGrams(null);
		setInsureAmount(null);
		setRates(null);
		setBought(null);
	}

	// biome-ignore lint/correctness/useExhaustiveDependencies: reset only calls state setters
	useEffect(() => {
		function onKeyDown(e: globalThis.KeyboardEvent) {
			if (e.ctrlKey && e.code === "Space") {
				e.preventDefault();
				setOpen((o) => {
					if (!o) reset();
					return !o;
				});
			}
		}
		window.addEventListener("keydown", onKeyDown);
		return () => window.removeEventListener("keydown", onKeyDown);
	}, []);

	useEffect(() => {
		if (open) listPackages().then(setBoxes);
	}, [open]);

	async function run<T>(work: () => Promise<T>) {
		setBusy(true);
		setError(null);
		try {
			return await work();
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
			return undefined;
		} finally {
			setBusy(false);
		}
	}

	const back = () => {
		setError(null);
		const order: Step[] = ["pin", "package", "weight", "insure", "rates"];
		const i = order.indexOf(step);
		if (step === "pin" || step === "done") return setOpen(false);
		let previous = order[i - 1];
		if (previous === "insure" && !found?.insure) previous = "weight";
		setStep(previous);
	};

	async function lookUp(pin: number) {
		const result = await run(() => quickShipLookup({ data: { pin } }));
		if (result === undefined) return;
		if (result === null) return setError(`No order to ship has pin ${pin}`);
		setFound(result);
		const lastBox = boxes.find((b) => b.id === result.last?.packageId) ?? null;
		setBox(lastBox);
		setDims(result.last ?? lastBox);
		setStep("package");
	}

	function choosePackage(next: { box: Box | null; dims: Dims }) {
		if (!found) return;
		setBox(next.box);
		setDims(next.dims);
		// Weight starts from these exact contents' last shipment, else the
		// items' known weights plus the empty box.
		setWeightGrams(
			found.last?.weightGrams ??
				(found.itemsWeightGrams === null
					? null
					: found.itemsWeightGrams + (next.box?.weightGrams ?? 0)),
		);
		setStep("weight");
	}

	function chooseWeight(grams: number) {
		if (!found) return;
		setWeightGrams(grams);
		if (found.insure) {
			setInsureAmount(found.order.total);
			setStep("insure");
		} else {
			setInsureAmount(null);
			loadRates(grams, null);
		}
	}

	async function loadRates(grams: number, insure: number | null) {
		if (!found || !dims) return;
		setStep("rates");
		setRates(null);
		const result = await run(() =>
			quickShipRates({
				data: {
					orderId: found.order.id,
					packageId: box?.id,
					...dims,
					weightGrams: grams,
					insureAmount: insure,
					contentsKey: found.contentsKey,
				},
			}),
		);
		if (result)
			setRates({ list: result.rates, notes: result.notes, test: result.test });
	}

	async function buy(rate: Rate) {
		if (!found || !dims || weightGrams === null) return;
		const result = await run(() =>
			quickShipBuy({
				data: {
					orderId: found.order.id,
					packageId: box?.id,
					...dims,
					weightGrams,
					insureAmount,
					contentsKey: found.contentsKey,
					rateId: rate.id,
				},
			}),
		);
		if (!result) return;
		setBought(result);
		setStep("done");
		window.open(result.labelUrl, "_blank");
		router.invalidate();
	}

	return (
		<Dialog open={open} onOpenChange={setOpen}>
			<DialogContent
				className="gap-0 overflow-hidden p-0 sm:max-w-lg"
				showCloseButton={false}
				onKeyDown={(e: KeyboardEvent) => {
					if (e.key === "Escape") {
						e.preventDefault();
						back();
					}
				}}
				onEscapeKeyDown={(e) => e.preventDefault()}
			>
				<DialogTitle className="flex items-center justify-between border-b px-4 py-3 text-sm font-semibold">
					<span>Quick ship{found && ` · ${found.order.name}`}</span>
					<span className="text-xs font-normal text-muted-foreground">
						Esc to go back
					</span>
				</DialogTitle>

				{found && step !== "pin" && <OrderSummary found={found} />}

				<div className="flex flex-col gap-3 p-4">
					{step === "pin" && (
						<PinPrompt label="Order pin" busy={busy} onSubmit={lookUp} />
					)}

					{step === "package" && found && found.labelSource !== "shippo" && (
						<p>
							{found.labelSource === "tiktok"
								? "This order ships on TikTok's own label. Printing TikTok labels is coming next; for now, print it from TikTok Seller Center."
								: "Amazon orders use Amazon's own labels, which need the restricted Amazon role you applied for. For now, buy it in Seller Central."}
						</p>
					)}

					{step === "package" && found?.labelSource === "shippo" && (
						<PackagePrompt
							boxes={boxes}
							current={box}
							dims={dims}
							onChoose={choosePackage}
						/>
					)}

					{step === "weight" && (
						<WeightPrompt
							initialGrams={weightGrams}
							hint={
								found?.last
									? "same as last time"
									: weightGrams !== null
										? "items plus box"
										: null
							}
							onSubmit={chooseWeight}
						/>
					)}

					{step === "insure" && found && (
						<InsurePrompt
							total={found.order.total}
							onSubmit={(amount) => {
								setInsureAmount(amount);
								if (weightGrams !== null) loadRates(weightGrams, amount);
							}}
						/>
					)}

					{step === "rates" && !(error && !rates) && (
						<RatesPrompt rates={rates} busy={busy} onBuy={buy} />
					)}

					{step === "done" && bought && (
						<DonePanel
							bought={bought}
							onNext={() => {
								reset();
							}}
						/>
					)}

					{error && <p className="text-critical-text">{error}</p>}
				</div>
			</DialogContent>
		</Dialog>
	);
}

function OrderSummary({ found }: { found: Found }) {
	const o = found.order;
	return (
		<div className="flex flex-col gap-2 border-b bg-[#f7f7f7] px-4 py-3">
			<div className="flex items-center justify-between gap-2">
				<span className="truncate">
					{o.customerName ?? "No name"}
					{o.shipCity && (
						<span className="text-muted-foreground">
							{" "}
							{[o.shipCity, o.shipRegion].filter(Boolean).join(", ")}
						</span>
					)}
				</span>
				<span className="flex shrink-0 gap-1.5">
					{found.labelsBought > 0 && <Badge tone="warning">Has a label</Badge>}
					<Badge>{o.salesChannel ?? o.channel}</Badge>
				</span>
			</div>
			<ul className="flex flex-col gap-1">
				{found.lines.map((l) => (
					<li key={`${l.sku}-${l.title}`} className="flex items-center gap-2">
						<ProductImage src={l.imageUrl} className="size-7" />
						<span className="font-semibold tabular-nums">{l.quantity}×</span>
						<span className="truncate">{l.title}</span>
					</li>
				))}
			</ul>
		</div>
	);
}

function PinPrompt({
	label,
	busy,
	onSubmit,
}: {
	label: string;
	busy: boolean;
	onSubmit: (pin: number) => void;
}) {
	const [value, setValue] = useState("");
	return (
		<label className="flex flex-col gap-1">
			<span className="text-muted-foreground">{label}</span>
			<input
				// biome-ignore lint/a11y/noAutofocus: the modal exists to type this
				autoFocus
				inputMode="numeric"
				maxLength={3}
				disabled={busy}
				value={value}
				onChange={(e) => setValue(e.target.value.replace(/\D/g, ""))}
				onKeyDown={(e) => {
					if (e.key === "Enter" && value.length === 3) onSubmit(Number(value));
				}}
				className="h-14 rounded-lg border border-input text-center text-3xl font-bold tracking-[0.3em] tabular-nums outline-none focus:border-ring focus:ring-1 focus:ring-ring"
			/>
		</label>
	);
}

function PackagePrompt({
	boxes,
	current,
	dims,
	onChoose,
}: {
	boxes: Box[];
	current: Box | null;
	dims: Dims | null;
	onChoose: (choice: { box: Box | null; dims: Dims }) => void;
}) {
	const [value, setValue] = useState(current ? String(current.pin) : "");
	const [custom, setCustom] = useState(!current && dims !== null);
	const [size, setSize] = useState(
		dims
			? `${inches(dims.lengthMm)} ${inches(dims.widthMm)} ${inches(dims.heightMm)}`
			: "",
	);
	const match = boxes.find((b) => String(b.pin) === value);

	function submit() {
		if (custom) {
			const parts = size
				.split(/[\s×xX,]+/)
				.map(Number)
				.filter((n) => n > 0);
			if (parts.length !== 3) return;
			const [l, w, h] = parts.map((n) => Math.round(n * MM_PER_INCH));
			onChoose({ box: null, dims: { lengthMm: l, widthMm: w, heightMm: h } });
		} else if (match) {
			onChoose({ box: match, dims: match });
		}
	}

	return (
		<div className="flex flex-col gap-2">
			<div className="flex items-center justify-between text-muted-foreground">
				<span>{custom ? "Box size in inches (L W H)" : "Box pin"}</span>
				<button
					type="button"
					className="text-link hover:underline"
					onClick={() => setCustom((c) => !c)}
				>
					{custom ? "Use a saved box" : "Custom size (C)"}
				</button>
			</div>
			{custom ? (
				<input
					// biome-ignore lint/a11y/noAutofocus: the step exists to type this
					autoFocus
					value={size}
					placeholder="12 9 4"
					onChange={(e) => setSize(e.target.value)}
					onKeyDown={(e) => e.key === "Enter" && submit()}
					className="h-12 rounded-lg border border-input px-3 text-xl tabular-nums outline-none focus:border-ring focus:ring-1 focus:ring-ring"
				/>
			) : (
				<input
					// biome-ignore lint/a11y/noAutofocus: the step exists to type this
					autoFocus
					inputMode="numeric"
					maxLength={3}
					value={value}
					onChange={(e) => {
						if (e.target.value.toLowerCase() === "c") return setCustom(true);
						setValue(e.target.value.replace(/\D/g, ""));
					}}
					onKeyDown={(e) => e.key === "Enter" && submit()}
					className="h-14 rounded-lg border border-input text-center text-3xl font-bold tracking-[0.3em] tabular-nums outline-none focus:border-ring focus:ring-1 focus:ring-ring"
				/>
			)}
			{!custom && (
				<p className="text-muted-foreground">
					{match
						? `${match.name}: ${inches(match.lengthMm)} × ${inches(match.widthMm)} × ${inches(match.heightMm)} in`
						: boxes.length === 0
							? "No boxes saved yet. Add them in Settings, or press C for a custom size."
							: value.length === 3
								? "No box has that pin."
								: ""}
				</p>
			)}
		</div>
	);
}

function WeightPrompt({
	initialGrams,
	hint,
	onSubmit,
}: {
	initialGrams: number | null;
	hint: string | null;
	onSubmit: (grams: number) => void;
}) {
	const [unit, setUnit] = useState<"oz" | "lb">("oz");
	const toUnit = (g: number) =>
		unit === "oz"
			? (g / GRAMS_PER_OUNCE).toFixed(1)
			: (g / GRAMS_PER_OUNCE / 16).toFixed(2);
	const [value, setValue] = useState(
		initialGrams === null ? "" : toUnit(initialGrams),
	);
	const input = useRef<HTMLInputElement>(null);

	function toggle() {
		const n = Number(value);
		const next = unit === "oz" ? "lb" : "oz";
		if (n > 0)
			setValue(next === "lb" ? (n / 16).toFixed(2) : (n * 16).toFixed(1));
		setUnit(next);
		input.current?.focus();
	}

	return (
		<div className="flex flex-col gap-2">
			<div className="flex items-center justify-between text-muted-foreground">
				<span>Weight{hint && ` (${hint})`}</span>
				<button
					type="button"
					className="text-link hover:underline"
					onClick={toggle}
				>
					Switch to {unit === "oz" ? "pounds" : "ounces"} (Tab)
				</button>
			</div>
			<div className="relative">
				<input
					ref={input}
					// biome-ignore lint/a11y/noAutofocus: the step exists to type this
					autoFocus
					inputMode="decimal"
					value={value}
					onFocus={(e) => e.target.select()}
					onChange={(e) => setValue(e.target.value.replace(/[^\d.]/g, ""))}
					onKeyDown={(e) => {
						if (e.key === "Tab") {
							e.preventDefault();
							toggle();
						}
						const n = Number(value);
						if (e.key === "Enter" && n > 0) {
							onSubmit(
								Math.round((unit === "oz" ? n : n * 16) * GRAMS_PER_OUNCE),
							);
						}
					}}
					className="h-14 w-full rounded-lg border border-input px-3 pr-14 text-3xl font-bold tabular-nums outline-none focus:border-ring focus:ring-1 focus:ring-ring"
				/>
				<span className="absolute top-4 right-4 text-lg text-muted-foreground">
					{unit}
				</span>
			</div>
		</div>
	);
}

function InsurePrompt({
	total,
	onSubmit,
}: {
	total: number;
	onSubmit: (amount: number | null) => void;
}) {
	const [choice, setChoice] = useState(0);
	const [custom, setCustom] = useState(String(Math.round(total)));
	const options = [
		`Insure for the order value, ${formatMoney(total)}`,
		"Insure for a different amount",
		"Don't insure",
	];

	function submit() {
		if (choice === 0) onSubmit(total);
		if (choice === 1 && Number(custom) > 0) onSubmit(Number(custom));
		if (choice === 2) onSubmit(null);
	}

	const group = useRef<HTMLDivElement>(null);
	useEffect(() => group.current?.focus(), []);

	return (
		<div
			ref={group}
			role="listbox"
			aria-label="Insurance"
			className="flex flex-col gap-2 outline-none"
			tabIndex={0}
			onKeyDown={(e) => {
				if (e.key === "ArrowDown") setChoice((c) => Math.min(c + 1, 2));
				if (e.key === "ArrowUp") setChoice((c) => Math.max(c - 1, 0));
				if (e.key === "Enter" && choice !== 1) submit();
			}}
		>
			<p className="font-semibold">This order should be insured</p>
			{options.map((label, i) => (
				<button
					key={label}
					type="button"
					onClick={() =>
						i === 1 ? setChoice(1) : onSubmit(i === 0 ? total : null)
					}
					className={cn(
						"rounded-lg border px-3 py-2 text-left",
						choice === i
							? "border-foreground bg-[#f1f1f1]"
							: "hover:bg-[#f7f7f7]",
					)}
				>
					{label}
				</button>
			))}
			{choice === 1 && (
				<input
					// biome-ignore lint/a11y/noAutofocus: shown only to type the amount
					autoFocus
					inputMode="decimal"
					value={custom}
					onChange={(e) => setCustom(e.target.value.replace(/[^\d.]/g, ""))}
					onKeyDown={(e) => e.key === "Enter" && submit()}
					className="h-11 rounded-lg border border-input px-3 text-lg tabular-nums outline-none focus:border-ring"
				/>
			)}
		</div>
	);
}

function RatesPrompt({
	rates,
	busy,
	onBuy,
}: {
	rates: { list: Rate[]; notes: string[]; test: boolean } | null;
	busy: boolean;
	onBuy: (rate: Rate) => void;
}) {
	const [selected, setSelected] = useState(0);
	const list = useRef<HTMLDivElement>(null);
	useEffect(() => {
		if (rates) list.current?.focus();
	}, [rates]);

	if (!rates) return <p className="text-muted-foreground">Getting prices…</p>;
	if (rates.list.length === 0) {
		return (
			<p className="text-critical-text">
				No services available.
				{rates.notes.length > 0 && ` ${rates.notes.join(" ")}`}
			</p>
		);
	}
	return (
		<div
			ref={list}
			role="listbox"
			aria-label="Services"
			className="flex flex-col gap-1 outline-none"
			tabIndex={0}
			onKeyDown={(e) => {
				if (e.key === "ArrowDown")
					setSelected((i) => Math.min(i + 1, rates.list.length - 1));
				if (e.key === "ArrowUp") setSelected((i) => Math.max(i - 1, 0));
				if (e.key === "Enter" && !busy) onBuy(rates.list[selected]);
			}}
		>
			<div className="flex items-center justify-between pb-1 text-muted-foreground">
				<span>Enter buys the highlighted label</span>
				{rates.test && <Badge tone="info">Test labels</Badge>}
			</div>
			{rates.list.map((r, i) => (
				<button
					key={r.id}
					type="button"
					disabled={busy}
					onMouseMove={() => setSelected(i)}
					onClick={() => onBuy(r)}
					className={cn(
						"flex items-center justify-between rounded-lg px-3 py-2 text-left",
						i === selected ? "bg-[#303030] text-white" : "hover:bg-[#f7f7f7]",
					)}
				>
					<span>
						{r.serviceName}
						{r.days !== null && (
							<span
								className={
									i === selected ? "text-white/70" : "text-muted-foreground"
								}
							>
								{" "}
								{r.days} {r.days === 1 ? "day" : "days"}
							</span>
						)}
					</span>
					<span className="font-semibold tabular-nums">
						{formatMoney(r.cost)}
					</span>
				</button>
			))}
			{busy && <p className="text-muted-foreground">Buying label…</p>}
		</div>
	);
}

function DonePanel({
	bought,
	onNext,
}: {
	bought: Awaited<ReturnType<typeof quickShipBuy>>;
	onNext: () => void;
}) {
	return (
		<div className="flex flex-col gap-2">
			<p className="font-semibold">
				Label bought{bought.test && " (test label, can't ship)"}
			</p>
			<p className="text-muted-foreground">
				{bought.serviceName}, {formatMoney(bought.cost)}
				{bought.trackingNumber && `, tracking ${bought.trackingNumber}`}
			</p>
			<a
				href={bought.labelUrl}
				target="_blank"
				rel="noreferrer"
				className="text-link hover:underline"
			>
				Open the label again
			</a>
			<Button autoFocus className="self-start" onClick={onNext}>
				Next order (Enter)
			</Button>
		</div>
	);
}
