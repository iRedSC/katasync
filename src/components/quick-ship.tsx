import { useRouter } from "@tanstack/react-router";
import {
	CircleAlert,
	CircleCheck,
	ExternalLink,
	LoaderCircle,
} from "lucide-react";
import {
	type KeyboardEvent,
	type ReactNode,
	useEffect,
	useRef,
	useState,
} from "react";
import { Badge } from "#/components/page";
import { ProductImage } from "#/components/product";
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
type Rates = { list: Rate[]; notes: string[]; test: boolean };
type Bought = Awaited<ReturnType<typeof quickShipBuy>>;

const inches = (mm: number) => Math.round((mm / MM_PER_INCH) * 10) / 10;
const ounces = (grams: number) => (grams / GRAMS_PER_OUNCE).toFixed(1);
const size = (d: Dims) =>
	`${inches(d.lengthMm)} × ${inches(d.widthMm)} × ${inches(d.heightMm)}`;

// The big inputs every step types into.
const bigInput =
	"h-24 w-full rounded-xl border-2 border-input bg-white text-center text-6xl font-bold tabular-nums outline-none focus:border-[#303030] disabled:opacity-60";

// Ctrl+Space anywhere: order pin, box pin, weight, (insurance), service.
// Enter moves forward, Escape steps back. The order loads as the third
// digit is typed, and prices load while the weight is still on screen, so
// Enter rarely waits.
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
	const [draftGrams, setDraftGrams] = useState<number | null>(null);
	const [insureAmount, setInsureAmount] = useState<number | null>(null);
	const [rates, setRates] = useState<Rates | null>(null);
	const [bought, setBought] = useState<Bought | null>(null);

	// Lookups and prices already asked for, so asking again is instant.
	const lookups = useRef(new Map<number, Promise<Found | null>>());
	const priced = useRef(new Map<string, Promise<Rates>>());
	const latest = useRef(0);

	function reset() {
		setStep("pin");
		setError(null);
		setFound(null);
		setBox(null);
		setDims(null);
		setWeightGrams(null);
		setDraftGrams(null);
		setInsureAmount(null);
		setRates(null);
		setBought(null);
		lookups.current.clear();
		priced.current.clear();
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

	function lookUp(pin: number) {
		let pending = lookups.current.get(pin);
		if (!pending) {
			pending = quickShipLookup({ data: { pin } });
			pending.catch(() => lookups.current.delete(pin));
			lookups.current.set(pin, pending);
		}
		return pending;
	}

	function priceFor(grams: number, insure: number | null) {
		if (!found || !dims) return null;
		const key = JSON.stringify([box?.id, dims, grams, insure]);
		let pending = priced.current.get(key);
		if (!pending) {
			pending = quickShipRates({
				data: {
					orderId: found.order.id,
					packageId: box?.id,
					...dims,
					weightGrams: grams,
					insureAmount: insure,
					contentsKey: found.contentsKey,
				},
			}).then((r) => ({ list: r.rates, notes: r.notes, test: r.test }));
			pending.catch(() => priced.current.delete(key));
			priced.current.set(key, pending);
		}
		return pending;
	}

	// Ask for prices as soon as a weight sits still for a moment, using the
	// insurance the next step would suggest.
	// biome-ignore lint/correctness/useExhaustiveDependencies: priceFor reads the same state
	useEffect(() => {
		if (step !== "weight" || !draftGrams || !found) return;
		const timer = setTimeout(() => {
			priceFor(draftGrams, found.insure ? found.order.total : null)?.catch(
				() => {},
			);
		}, 250);
		return () => clearTimeout(timer);
	}, [step, draftGrams, found]);

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
		if (step === "pin" || step === "done") return setOpen(false);
		const order: Step[] = ["pin", "package", "weight", "insure", "rates"];
		let previous = order[order.indexOf(step) - 1];
		if (previous === "insure" && !found?.insure) previous = "weight";
		latest.current++;
		setStep(previous);
	};

	async function choosePin(pin: number) {
		const result = await run(() => lookUp(pin));
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
		const grams =
			found.last?.weightGrams ??
			(found.itemsWeightGrams === null
				? null
				: found.itemsWeightGrams + (next.box?.weightGrams ?? 0));
		setWeightGrams(grams);
		setDraftGrams(grams);
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
			showRates(grams, null);
		}
	}

	async function showRates(grams: number, insure: number | null) {
		const pending = priceFor(grams, insure);
		if (!pending) return;
		const mine = ++latest.current;
		setStep("rates");
		setRates(null);
		const result = await run(() => pending);
		if (result && mine === latest.current) setRates(result);
	}

	async function buy(rate: Rate) {
		if (!found || !dims || weightGrams === null || busy) return;
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

	const external = found?.external ?? null;
	const steps: { id: Step; label: string; value: string | null }[] = external
		? [
				{ id: "pin", label: "Order", value: found?.order.name ?? null },
				{ id: "package", label: "Ship on", value: external.name },
			]
		: [
				{ id: "pin", label: "Order", value: found?.order.name ?? null },
				{
					id: "package",
					label: "Box",
					value: box ? box.name : dims ? `${size(dims)} in` : null,
				},
				{
					id: "weight",
					label: "Weight",
					value: weightGrams ? `${ounces(weightGrams)} oz` : null,
				},
				...(found?.insure
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

	return (
		<Dialog open={open} onOpenChange={setOpen}>
			<DialogContent
				className="grid-cols-[minmax(0,1fr)] gap-0 overflow-hidden bg-card p-0 sm:max-w-2xl"
				showCloseButton={false}
				onKeyDown={(e: KeyboardEvent) => {
					// An Enter typed in a field finishes that step only. Without this,
					// the same keypress lands on the next step's button and presses it.
					if (e.key === "Enter" && e.target instanceof HTMLInputElement) {
						e.preventDefault();
					}
					if (e.key === "Escape") {
						e.preventDefault();
						back();
					}
				}}
				onEscapeKeyDown={(e) => e.preventDefault()}
			>
				<DialogTitle className="sr-only">Quick ship</DialogTitle>
				<StepStrip steps={steps} current={step} />

				{found && step !== "pin" && <OrderSummary found={found} />}

				<div className="flex flex-col gap-4 p-6">
					{step === "pin" && (
						<PinStep busy={busy} lookUp={lookUp} onSubmit={choosePin} />
					)}

					{step === "package" && external && (
						<ExternalStep
							name={external.name}
							onOpen={() => {
								window.open(external.url, "_blank", "noreferrer");
								setOpen(false);
							}}
						/>
					)}

					{step === "package" && found && !external && (
						<PackageStep
							boxes={boxes}
							current={box}
							dims={dims}
							onChoose={choosePackage}
						/>
					)}

					{step === "weight" && (
						<WeightStep
							initialGrams={weightGrams}
							hint={
								found?.last
									? "Same as last time"
									: weightGrams !== null
										? "Items plus box"
										: null
							}
							onDraft={setDraftGrams}
							onSubmit={chooseWeight}
						/>
					)}

					{step === "insure" && found && (
						<InsureStep
							total={found.order.total}
							onSubmit={(amount) => {
								setInsureAmount(amount);
								if (weightGrams !== null) showRates(weightGrams, amount);
							}}
						/>
					)}

					{step === "rates" && !(error && !rates) && (
						<RatesStep rates={rates} busy={busy} onBuy={buy} />
					)}

					{step === "done" && bought && (
						<DoneStep bought={bought} onNext={reset} />
					)}

					{error && <Notice tone="critical">{error}</Notice>}

					<p className="text-center text-muted-foreground">
						<Key>Enter</Key> next · <Key>Esc</Key> back
					</p>
				</div>
			</DialogContent>
		</Dialog>
	);
}

// Every choice so far, big enough to check from arm's length.
function StepStrip({
	steps,
	current,
}: {
	steps: { id: Step; label: string; value: string | null }[];
	current: Step;
}) {
	return (
		<ol className="grid auto-cols-fr grid-flow-col border-b bg-[#f7f7f7]">
			{steps.map((s) => {
				const active = s.id === current;
				return (
					<li
						key={s.id}
						className={cn(
							"min-w-0 border-b-4 px-4 pt-3 pb-2",
							// Marketplace order numbers run long; the order gets two shares.
							s.id === "pin" && "col-span-2",
							active ? "border-[#303030] bg-white" : "border-transparent",
						)}
					>
						<div className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
							{s.label}
						</div>
						<div
							className={cn(
								"truncate text-lg font-semibold",
								!s.value && "text-[#b5b5b5]",
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

function OrderSummary({ found }: { found: Found }) {
	const o = found.order;
	return (
		<div className="flex flex-col gap-3 border-b px-6 py-4">
			<div className="flex items-center justify-between gap-3">
				<div className="min-w-0">
					<div className="truncate text-xl font-semibold">
						{o.customerName ?? "No name"}
					</div>
					{o.shipCity && (
						<div className="text-muted-foreground">
							{[o.shipCity, o.shipRegion].filter(Boolean).join(", ")}
						</div>
					)}
				</div>
				<div className="flex shrink-0 gap-1.5">
					{found.labelsBought > 0 && (
						<Badge tone="warning">Already has a label</Badge>
					)}
					<Badge>{o.salesChannel ?? o.channel}</Badge>
				</div>
			</div>
			<ul className="flex flex-col gap-2">
				{found.lines.map((l) => (
					<li key={`${l.sku}-${l.title}`} className="flex items-center gap-3">
						<ProductImage src={l.imageUrl} className="size-12" />
						<span className="w-12 shrink-0 text-2xl font-bold tabular-nums">
							{l.quantity}×
						</span>
						<span className="min-w-0 truncate text-base">{l.title}</span>
					</li>
				))}
			</ul>
		</div>
	);
}

function PinStep({
	busy,
	lookUp,
	onSubmit,
}: {
	busy: boolean;
	lookUp: (pin: number) => Promise<Found | null>;
	onSubmit: (pin: number) => void;
}) {
	const [value, setValue] = useState("");
	const [preview, setPreview] = useState<Found | null | "loading">(null);

	// Every keystroke looks the pin up, so Enter usually has nothing to wait
	// for. lookUp caches by pin, so only the typed value matters here.
	// biome-ignore lint/correctness/useExhaustiveDependencies: see above
	useEffect(() => {
		if (!value) return setPreview(null);
		let current = true;
		setPreview("loading");
		lookUp(Number(value))
			.then((f) => current && setPreview(f))
			.catch(() => current && setPreview(null));
		return () => {
			current = false;
		};
	}, [value]);

	return (
		<div className="flex flex-col gap-3">
			<p className="text-center text-xl font-semibold">Order pin</p>
			<input
				// biome-ignore lint/a11y/noAutofocus: the modal exists to type this
				autoFocus
				inputMode="numeric"
				maxLength={3}
				disabled={busy}
				value={value}
				onChange={(e) => setValue(e.target.value.replace(/\D/g, ""))}
				onKeyDown={(e) => {
					if (e.key === "Enter" && Number(value) > 0) onSubmit(Number(value));
				}}
				className={cn(bigInput, "tracking-[0.4em] placeholder:text-[#e3e3e3]")}
			/>
			<div className="flex h-8 items-center justify-center text-lg">
				{preview === "loading" && <Spinner />}
				{preview && preview !== "loading" && (
					<span>
						<span className="font-semibold">{preview.order.name}</span>
						<span className="text-muted-foreground">
							{" "}
							· {preview.order.customerName ?? "No name"} ·{" "}
							{preview.lines.reduce((n, l) => n + l.quantity, 0)} items
							{preview.external && ` · ships on ${preview.external.name}`}
						</span>
					</span>
				)}
				{preview === null && value && (
					<span className="text-critical-text">No order has that pin</span>
				)}
			</div>
		</div>
	);
}

function PackageStep({
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
	const [typed, setTyped] = useState(
		dims
			? `${inches(dims.lengthMm)} ${inches(dims.widthMm)} ${inches(dims.heightMm)}`
			: "",
	);
	const match = boxes.find((b) => String(b.pin) === value);
	const parts = typed
		.split(/[\s×xX,]+/)
		.map(Number)
		.filter((n) => n > 0);

	function submit() {
		if (custom && parts.length === 3) {
			const [l, w, h] = parts.map((n) => Math.round(n * MM_PER_INCH));
			onChoose({ box: null, dims: { lengthMm: l, widthMm: w, heightMm: h } });
		} else if (!custom && match) {
			onChoose({ box: match, dims: match });
		}
	}

	return (
		<div className="flex flex-col gap-3">
			<div className="flex items-baseline justify-between">
				<p className="text-xl font-semibold">
					{custom ? "Box size in inches" : "Box pin"}
				</p>
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
					value={typed}
					placeholder="12 9 4"
					onFocus={(e) => e.target.select()}
					onChange={(e) => setTyped(e.target.value)}
					onKeyDown={(e) => e.key === "Enter" && submit()}
					className={cn(bigInput, "text-5xl placeholder:text-[#e3e3e3]")}
				/>
			) : (
				<input
					// biome-ignore lint/a11y/noAutofocus: the step exists to type this
					autoFocus
					inputMode="numeric"
					maxLength={3}
					value={value}
					onFocus={(e) => e.target.select()}
					onChange={(e) => {
						if (e.target.value.toLowerCase().endsWith("c")) {
							return setCustom(true);
						}
						setValue(e.target.value.replace(/\D/g, ""));
					}}
					onKeyDown={(e) => e.key === "Enter" && submit()}
					className={cn(
						bigInput,
						"tracking-[0.4em] placeholder:text-[#e3e3e3]",
					)}
				/>
			)}
			<div className="flex h-8 items-center justify-center text-lg">
				{custom ? (
					parts.length === 3 ? (
						<span className="font-semibold">{parts.join(" × ")} in</span>
					) : (
						<span className="text-muted-foreground">Length, width, height</span>
					)
				) : match ? (
					<span>
						<span className="font-semibold">{match.name}</span>
						<span className="text-muted-foreground"> · {size(match)} in</span>
					</span>
				) : boxes.length === 0 ? (
					<span className="text-muted-foreground">
						No saved boxes yet. Press C for a custom size.
					</span>
				) : value ? (
					<span className="text-critical-text">No box has that pin</span>
				) : null}
			</div>
		</div>
	);
}

function WeightStep({
	initialGrams,
	hint,
	onDraft,
	onSubmit,
}: {
	initialGrams: number | null;
	hint: string | null;
	onDraft: (grams: number | null) => void;
	onSubmit: (grams: number) => void;
}) {
	const [unit, setUnit] = useState<"oz" | "lb">("oz");
	const [value, setValue] = useState(
		initialGrams === null ? "" : ounces(initialGrams),
	);
	const input = useRef<HTMLInputElement>(null);
	const grams = (text: string, u: "oz" | "lb") => {
		const n = Number(text);
		return n > 0
			? Math.round((u === "oz" ? n : n * 16) * GRAMS_PER_OUNCE)
			: null;
	};

	function toggle() {
		const n = Number(value);
		const next = unit === "oz" ? "lb" : "oz";
		if (n > 0) {
			setValue(next === "lb" ? (n / 16).toFixed(2) : (n * 16).toFixed(1));
		}
		setUnit(next);
		input.current?.focus();
	}

	return (
		<div className="flex flex-col gap-3">
			<div className="flex items-baseline justify-between">
				<p className="text-xl font-semibold">Weight</p>
				{hint && <span className="text-muted-foreground">{hint}</span>}
			</div>
			<div className="relative">
				<input
					ref={input}
					// biome-ignore lint/a11y/noAutofocus: the step exists to type this
					autoFocus
					inputMode="decimal"
					value={value}
					placeholder="0"
					onFocus={(e) => e.target.select()}
					onChange={(e) => {
						const text = e.target.value.replace(/[^\d.]/g, "");
						setValue(text);
						onDraft(grams(text, unit));
					}}
					onKeyDown={(e) => {
						if (e.key === "Tab") {
							e.preventDefault();
							toggle();
						}
						const g = grams(value, unit);
						if (e.key === "Enter" && g) onSubmit(g);
					}}
					className={cn(bigInput, "pr-24 placeholder:text-[#e3e3e3]")}
				/>
				<button
					type="button"
					onClick={toggle}
					className="absolute top-1/2 right-3 -translate-y-1/2 rounded-lg bg-[#f1f1f1] px-3 py-2 text-2xl font-semibold hover:bg-[#e3e3e3]"
				>
					{unit}
				</button>
			</div>
			<p className="text-center text-muted-foreground">
				<Key>Tab</Key> switches to {unit === "oz" ? "pounds" : "ounces"}
			</p>
		</div>
	);
}

function InsureStep({
	total,
	onSubmit,
}: {
	total: number;
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
			<p className="text-xl font-semibold">Insure this package?</p>
			{options.map((o, i) => (
				<button
					key={o.label}
					type="button"
					onMouseMove={() => setChoice(i)}
					onClick={() => (i === 1 ? setChoice(1) : submit(i))}
					className={cn(
						"flex h-16 items-center justify-between rounded-xl border-2 px-5 text-left text-xl",
						choice === i
							? "border-[#303030] bg-[#303030] text-white"
							: "border-[#e3e3e3] hover:bg-[#f7f7f7]",
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

function RatesStep({
	rates,
	busy,
	onBuy,
}: {
	rates: Rates | null;
	busy: boolean;
	onBuy: (rate: Rate) => void;
}) {
	const [selected, setSelected] = useState(0);
	const list = useRef<HTMLDivElement>(null);
	useEffect(() => {
		if (rates) list.current?.focus();
	}, [rates]);

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
				No services available.
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
					setSelected((i) => Math.min(i + 1, rates.list.length - 1));
				}
				if (e.key === "ArrowUp") setSelected((i) => Math.max(i - 1, 0));
				if (e.key === "Enter") onBuy(rates.list[selected]);
			}}
		>
			<div className="flex items-baseline justify-between">
				<p className="text-xl font-semibold">
					{busy ? "Buying label…" : "Enter buys the label"}
				</p>
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
						"flex h-16 items-center justify-between rounded-xl border-2 px-5 text-left",
						i === selected
							? "border-[#303030] bg-[#303030] text-white"
							: "border-[#e3e3e3] hover:bg-[#f7f7f7]",
						busy && i !== selected && "opacity-40",
					)}
				>
					<span className="min-w-0">
						<span className="block truncate text-lg font-semibold">
							{r.serviceName}
						</span>
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
	);
}

function DoneStep({ bought, onNext }: { bought: Bought; onNext: () => void }) {
	const next = useRef<HTMLButtonElement>(null);
	useEffect(() => next.current?.focus(), []);
	return (
		<div className="flex flex-col items-center gap-3 rounded-xl bg-success-surface px-6 py-8 text-center">
			<CircleCheck className="size-16 text-success-icon" />
			<p className="text-4xl font-bold">Label bought</p>
			<p className="text-xl">
				{bought.serviceName} ·{" "}
				<span className="font-semibold">{formatMoney(bought.cost)}</span>
			</p>
			{bought.test && (
				<Badge tone="info">Test label: it won't ship anything</Badge>
			)}
			{bought.trackingNumber && (
				<p className="font-mono text-muted-foreground">
					{bought.trackingNumber}
				</p>
			)}
			<div className="mt-2 flex items-center gap-4">
				<button
					ref={next}
					type="button"
					onClick={onNext}
					className="h-14 rounded-xl bg-[#303030] px-8 text-xl font-semibold text-white outline-none hover:bg-[#1a1a1a] focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
				>
					Next order
				</button>
				<a
					href={bought.labelUrl}
					target="_blank"
					rel="noreferrer"
					className="text-lg text-link hover:underline"
				>
					Open label again
				</a>
			</div>
		</div>
	);
}

function Notice({
	tone,
	children,
}: {
	tone: "critical" | "info";
	children: ReactNode;
}) {
	return (
		<div
			className={cn(
				"flex items-start gap-3 rounded-xl border-2 px-5 py-4 text-lg",
				tone === "critical"
					? "border-critical-border bg-critical-surface text-critical-text"
					: "border-info-border bg-info-surface text-info-text",
			)}
		>
			<CircleAlert className="mt-0.5 size-6 shrink-0" />
			<span>{children}</span>
		</div>
	);
}

function Key({ children }: { children: ReactNode }) {
	return (
		<kbd className="rounded border border-b-2 bg-white px-1.5 py-0.5 font-sans text-xs font-semibold text-foreground">
			{children}
		</kbd>
	);
}

function Spinner() {
	return <LoaderCircle className="size-6 animate-spin" />;
}

// Orders whose label comes from the marketplace: Enter opens its page.
function ExternalStep({ name, onOpen }: { name: string; onOpen: () => void }) {
	const button = useRef<HTMLButtonElement>(null);
	useEffect(() => button.current?.focus(), []);
	return (
		<div className="flex flex-col items-center gap-4 py-4 text-center">
			<p className="text-2xl font-semibold">Ships on {name}'s own label</p>
			<button
				ref={button}
				type="button"
				onClick={onOpen}
				className="inline-flex h-16 items-center gap-3 rounded-xl bg-[#303030] px-8 text-xl font-semibold text-white outline-none hover:bg-[#1a1a1a] focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
			>
				Press Enter to go to the fulfillment page
				<ExternalLink className="size-6" />
			</button>
		</div>
	);
}
