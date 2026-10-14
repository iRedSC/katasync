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
import { printLabels } from "#/components/print-labels";
import { ProductImage } from "#/components/product";
import { Dialog, DialogContent, DialogTitle } from "#/components/ui/dialog";
import { formatMoney } from "#/lib/format";
import { cn } from "#/lib/utils";
import {
	listPackages,
	quickShipBuy,
	quickShipLookup,
	quickShipPlan,
	quickShipRates,
	savePackage,
	voidLabel,
} from "#/server/shipping";
import { labelPath } from "#/shipping/label-path";
import type { ShipmentPlan } from "#/shipping/quick-ship";
import type { Rate } from "#/shipping/shippo";

const MM_PER_INCH = 25.4;
const GRAMS_PER_OUNCE = 28.349523125;
// Matches MAX_BOXES in shipping/buy.ts, which the server enforces.
const MAX_BOXES = 10;

type Found = NonNullable<Awaited<ReturnType<typeof quickShipLookup>>>;
type Box = Awaited<ReturnType<typeof listPackages>>[number];
type Dims = { lengthMm: number; widthMm: number; heightMm: number };
// A box already packed and weighed, before buying.
type Packed = { box: Box | null; dims: Dims; weightGrams: number };
type Step = "pin" | "package" | "weight" | "insure" | "rates" | "done";
type Rates = { list: Rate[]; notes: string[]; test: boolean };
type Bought = Awaited<ReturnType<typeof quickShipBuy>>;

const inches = (mm: number) => Math.round((mm / MM_PER_INCH) * 10) / 10;
const ounces = (grams: number) => (grams / GRAMS_PER_OUNCE).toFixed(1);
const size = (d: Dims) =>
	`${inches(d.lengthMm)} × ${inches(d.widthMm)} × ${inches(d.heightMm)}`;

// Splits the insured amount across boxes by cents, the last box taking any
// leftover cent, so the parts add up to what was chosen.
function splitInsurance(total: number | null, boxes: number) {
	if (total === null) return Array<null>(boxes).fill(null);
	const cents = Math.round(total * 100);
	const each = Math.floor(cents / boxes);
	return Array.from(
		{ length: boxes },
		(_, i) => (i === boxes - 1 ? cents - each * (boxes - 1) : each) / 100,
	);
}

// The big inputs every step types into.
const bigInput =
	"h-24 w-full rounded-xl border-2 border-input bg-white text-center text-6xl font-bold tabular-nums outline-none focus:border-[#303030] disabled:opacity-60";

// Opens quick ship already on this order, past the pin step (the order
// page's Ship button).
export function openQuickShip(pin: number) {
	window.dispatchEvent(new CustomEvent("quick-ship", { detail: pin }));
}

// Ctrl+Space anywhere: order pin, box pin, weight, (insurance), service.
// T on the box step adds other orders to the same address to this box; +
// on the weight step adds another box. Enter moves forward, Escape steps
// back. The order loads as the third digit is typed, and prices load while
// the weight is still on screen, so Enter rarely waits.
export function QuickShip() {
	const router = useRouter();
	const [open, setOpen] = useState(false);
	const [step, setStep] = useState<Step>("pin");
	const [error, setError] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);
	const [boxes, setBoxes] = useState<Box[]>([]);

	const [found, setFound] = useState<Found | null>(null);
	// The orders in this box (the pin's order first) and what's in it.
	const [plan, setPlan] = useState<ShipmentPlan | null>(null);
	// Boxes finished so far; the one being entered is box/dims/weight below.
	const [packed, setPacked] = useState<Packed[]>([]);
	const [box, setBox] = useState<Box | null>(null);
	const [dims, setDims] = useState<Dims | null>(null);
	const [weightGrams, setWeightGrams] = useState<number | null>(null);
	const [draftGrams, setDraftGrams] = useState<number | null>(null);
	const [insureAmount, setInsureAmount] = useState<number | null>(null);
	const [rates, setRates] = useState<Rates | null>(null);
	const [bought, setBought] = useState<Bought | null>(null);

	// Lookups, plans, and prices already asked for, so asking again is
	// instant.
	const lookups = useRef(new Map<number, Promise<Found | null>>());
	const plans = useRef(new Map<string, Promise<ShipmentPlan>>());
	const priced = useRef(new Map<string, Promise<Rates>>());
	const latest = useRef(0);

	function reset() {
		setStep("pin");
		setError(null);
		setFound(null);
		setPlan(null);
		setPacked([]);
		setBox(null);
		setDims(null);
		setWeightGrams(null);
		setDraftGrams(null);
		setInsureAmount(null);
		setRates(null);
		setBought(null);
		lookups.current.clear();
		plans.current.clear();
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
		function onOpen(e: Event) {
			reset();
			setOpen(true);
			choosePinRef.current((e as CustomEvent<number>).detail);
		}
		window.addEventListener("keydown", onKeyDown);
		window.addEventListener("quick-ship", onOpen);
		return () => {
			window.removeEventListener("keydown", onKeyDown);
			window.removeEventListener("quick-ship", onOpen);
		};
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

	function planFor(orderIds: number[]) {
		const key = orderIds.join(",");
		let pending = plans.current.get(key);
		if (!pending) {
			pending = quickShipPlan({ data: { orderIds } });
			pending.catch(() => plans.current.delete(key));
			plans.current.set(key, pending);
		}
		return pending;
	}

	// Every box with its weight, the one being entered last.
	const allBoxes = (grams: number | null): Packed[] =>
		dims && grams ? [...packed, { box, dims, weightGrams: grams }] : packed;

	function priceFor(list: Packed[], insure: number | null) {
		if (!plan || list.length === 0) return null;
		const parts = splitInsurance(insure, list.length);
		const data = {
			orderIds: plan.orderIds,
			contentsKey: plan.contentsKey,
			boxes: list.map((p, i) => ({
				packageId: p.box?.id ?? null,
				...p.dims,
				weightGrams: p.weightGrams,
				insureAmount: parts[i],
			})),
		};
		const key = JSON.stringify(data);
		let pending = priced.current.get(key);
		if (!pending) {
			pending = quickShipRates({ data }).then((r) => ({
				list: r.rates,
				notes: r.notes,
				test: r.test,
			}));
			pending.catch(() => priced.current.delete(key));
			priced.current.set(key, pending);
		}
		return pending;
	}

	// Ask for prices as soon as a weight sits still for a moment, using the
	// insurance the next step would suggest.
	// biome-ignore lint/correctness/useExhaustiveDependencies: priceFor reads the same state
	useEffect(() => {
		if (step !== "weight" || !draftGrams || !plan) return;
		const timer = setTimeout(() => {
			priceFor(allBoxes(draftGrams), plan.insure ? plan.total : null)?.catch(
				() => {},
			);
		}, 250);
		return () => clearTimeout(timer);
	}, [step, draftGrams, plan]);

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
		latest.current++;
		// From a later box's box step, back to the box before's weight.
		if (step === "package" && packed.length > 0) {
			const last = packed[packed.length - 1];
			setPacked(packed.slice(0, -1));
			setBox(last.box);
			setDims(last.dims);
			setWeightGrams(last.weightGrams);
			setDraftGrams(last.weightGrams);
			return setStep("weight");
		}
		const order: Step[] = ["pin", "package", "weight", "insure", "rates"];
		let previous = order[order.indexOf(step) - 1];
		if (previous === "insure" && !plan?.insure) previous = "weight";
		setStep(previous);
	};

	// Starts a box from the matching box of the last time these contents
	// shipped, if there was one.
	function suggestBox(next: ShipmentPlan, index: number, known = boxes) {
		const last = next.last?.[index] ?? null;
		const lastBox = known.find((b) => b.id === last?.packageId) ?? null;
		setBox(lastBox);
		setDims(last ?? lastBox);
	}

	async function choosePin(pin: number) {
		const result = await run(() => lookUp(pin));
		if (result === undefined) return;
		if (result === null) return setError(`No order to ship has pin ${pin}`);
		setFound(result);
		setPlan(result.plan);
		// Ready if T is pressed.
		if (result.companions.length > 0) {
			planFor([result.order.id, ...result.companions.map((c) => c.id)]).catch(
				() => {},
			);
		}
		// Opened straight onto an order, the boxes may still be loading.
		const known = boxes.length > 0 ? boxes : await listPackages();
		if (boxes.length === 0) setBoxes(known);
		suggestBox(result.plan, 0, known);
		setStep("package");
	}

	// The listener above is set up once; this keeps it calling the current
	// choosePin.
	const choosePinRef = useRef(choosePin);
	choosePinRef.current = choosePin;

	// Adds or removes another order to the same address from this box. Only
	// while choosing the first box: the contents decide the boxes.
	async function toggleCompanion(id?: number) {
		if (!found || !plan || packed.length > 0 || busy) return;
		const chosen = new Set(plan.orderIds.slice(1));
		const ids = id === undefined ? found.companions.map((c) => c.id) : [id];
		const adding = ids.some((i) => !chosen.has(i));
		for (const i of ids) adding ? chosen.add(i) : chosen.delete(i);
		const orderIds = [
			found.order.id,
			...found.companions.map((c) => c.id).filter((i) => chosen.has(i)),
		];
		// busy holds the box step until the new contents are known, so the box
		// and prices are never for the old plan.
		const next = await run(() => planFor(orderIds));
		if (!next) return;
		setPlan(next);
		setRates(null);
		latest.current++;
		if (next.last) suggestBox(next, 0);
	}

	function choosePackage(next: { box: Box | null; dims: Dims }) {
		if (!plan || busy) return;
		setBox(next.box);
		setDims(next.dims);
		// Weight starts from this box's weight last time these contents
		// shipped; else, for a single box, the items' known weights plus the
		// empty box.
		const last = plan.last?.[packed.length];
		const grams =
			last?.weightGrams ??
			(packed.length === 0 && plan.itemsWeightGrams !== null
				? plan.itemsWeightGrams + (next.box?.weightGrams ?? 0)
				: null);
		setWeightGrams(grams);
		setDraftGrams(grams);
		setStep("weight");
	}

	// + on the weight step: this box is done, on to the next.
	function anotherBox(grams: number) {
		if (!dims || !plan) return;
		if (packed.length + 1 >= MAX_BOXES) {
			return setError(`At most ${MAX_BOXES} boxes in one shipment`);
		}
		setPacked([...packed, { box, dims, weightGrams: grams }]);
		suggestBox(plan, packed.length + 1);
		setWeightGrams(null);
		setDraftGrams(null);
		setError(null);
		setStep("package");
	}

	function chooseWeight(grams: number) {
		if (!plan) return;
		setWeightGrams(grams);
		if (plan.insure) {
			setInsureAmount(plan.total);
			setStep("insure");
		} else {
			setInsureAmount(null);
			showRates(allBoxes(grams), null);
		}
	}

	async function showRates(list: Packed[], insure: number | null) {
		const pending = priceFor(list, insure);
		if (!pending) return;
		const mine = ++latest.current;
		setStep("rates");
		setRates(null);
		const result = await run(() => pending);
		if (result && mine === latest.current) setRates(result);
	}

	async function buy(quote: Rate) {
		const list = allBoxes(weightGrams);
		if (!plan || list.length === 0 || busy) return;
		const parts = splitInsurance(insureAmount, list.length);
		const result = await run(() =>
			quickShipBuy({
				data: {
					orderIds: plan.orderIds,
					contentsKey: plan.contentsKey,
					boxes: list.map((p, i) => ({
						packageId: p.box?.id ?? null,
						...p.dims,
						weightGrams: p.weightGrams,
						insureAmount: parts[i],
					})),
					choice: {
						carrier: quote.carrier,
						service: quote.service,
						id: quote.id,
					},
				},
			}),
		);
		if (!result) return;
		router.invalidate();
		if (result.failed) {
			// A label still live blocks buying again; it has to be voided.
			if (result.boxes.length > 0) {
				setRates(null);
				return setError(result.failed);
			}
			// Everything was refunded: show fresh prices to try again, keeping
			// the explanation on screen.
			priced.current.clear();
			await showRates(list, insureAmount);
			return setError(result.failed);
		}
		setBought(result);
		setStep("done");
		printLabels(result.boxes.map((b) => b.id));
	}

	const external = found?.external ?? null;
	const count = packed.length + (dims ? 1 : 0);
	const steps: { id: Step; label: string; value: string | null }[] = external
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
					if (
						(e.key === "t" || e.key === "T") &&
						step === "package" &&
						found?.companions.length
					) {
						e.preventDefault();
						toggleCompanion();
					}
				}}
				onEscapeKeyDown={(e) => e.preventDefault()}
			>
				<DialogTitle className="sr-only">Quick ship</DialogTitle>
				<StepStrip steps={steps} current={step} />

				{found && plan && step !== "pin" && (
					<OrderSummary
						found={found}
						plan={plan}
						canCombine={step === "package" && packed.length === 0}
						onToggle={toggleCompanion}
					/>
				)}

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

					{step === "package" &&
						found &&
						!external &&
						found.liveDispatchId !== null && (
							<Notice tone="info">
								This order already has a label. To ship it in a different box,
								void that label on the order page first.
							</Notice>
						)}

					{step === "package" &&
						found &&
						!external &&
						found.liveDispatchId === null && (
							<PackageStep
								// A fresh step for each box, starting from its suggestion.
								key={packed.length}
								boxes={boxes}
								current={box}
								dims={dims}
								onChoose={choosePackage}
								onSaved={(saved) => setBoxes((list) => [...list, saved])}
							/>
						)}

					{step === "weight" && (
						<WeightStep
							key={packed.length}
							initialGrams={weightGrams}
							hint={
								plan?.last?.[packed.length]
									? plan.last.length > 1
										? `Box ${packed.length + 1} of ${plan.last.length} last time`
										: "Same as last time"
									: weightGrams !== null
										? "Items plus box"
										: null
							}
							// Last time needed more boxes than packed so far.
							moreBoxes={(plan?.last?.length ?? 0) > packed.length + 1}
							onDraft={setDraftGrams}
							onSubmit={chooseWeight}
							onAnother={anotherBox}
						/>
					)}

					{step === "insure" && plan && (
						<InsureStep
							total={plan.total}
							boxes={count}
							onSubmit={(amount) => {
								setInsureAmount(amount);
								showRates(allBoxes(weightGrams), amount);
							}}
						/>
					)}

					{step === "rates" && !(error && !rates) && (
						<RatesStep rates={rates} boxes={count} busy={busy} onBuy={buy} />
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

function OrderSummary({
	found,
	plan,
	canCombine,
	onToggle,
}: {
	found: Found;
	plan: ShipmentPlan;
	canCombine: boolean;
	onToggle: (id?: number) => void;
}) {
	const o = found.order;
	const combined = plan.orderIds.length > 1;
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
					{found.liveDispatchId !== null && (
						<Badge tone="warning">Already has a label</Badge>
					)}
					<Badge>{o.salesChannel ?? o.channel}</Badge>
				</div>
			</div>
			<ul className="flex flex-col gap-2">
				{plan.lines.map((l, i) => (
					<li
						// biome-ignore lint/suspicious/noArrayIndexKey: lines never reorder within a plan
						key={i}
						className="flex items-center gap-3"
					>
						<ProductImage src={l.imageUrl} className="size-12" />
						<span className="w-12 shrink-0 text-2xl font-bold tabular-nums">
							{l.quantity}×
						</span>
						<span className="min-w-0 flex-1 truncate text-base">{l.title}</span>
						{combined && (
							<span className="shrink-0 text-muted-foreground">
								{plan.orderNames[plan.orderIds.indexOf(l.orderId)]}
							</span>
						)}
					</li>
				))}
			</ul>
			{found.companions.length > 0 && (
				<div className="flex flex-col gap-2 rounded-xl border-2 border-info-border bg-info-surface px-4 py-3 text-info-text">
					<p className="text-lg font-semibold">
						{found.companions.length === 1
							? "Another order goes to this address"
							: `${found.companions.length} more orders go to this address`}
						{canCombine && (
							<span className="font-normal">
								{" "}
								· <Key>T</Key> ships{" "}
								{found.companions.length === 1 ? "it" : "them"} in this box
							</span>
						)}
					</p>
					<ul className="flex flex-col gap-1">
						{found.companions.map((c) => {
							const included = plan.orderIds.includes(c.id);
							return (
								<li key={c.id}>
									<label className="flex items-center gap-3 text-base">
										<input
											type="checkbox"
											className="size-5"
											checked={included}
											disabled={!canCombine}
											onChange={() => onToggle(c.id)}
										/>
										<span className="font-semibold">{c.name}</span>
										{c.pin !== null && <span>pin {c.pin}</span>}
										<span>
											· {c.customerName ?? "No name"} · {c.items}{" "}
											{c.items === 1 ? "item" : "items"}
										</span>
									</label>
								</li>
							);
						})}
					</ul>
				</div>
			)}
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
							{preview.plan.lines.reduce((n, l) => n + l.quantity, 0)} items
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
	onSaved,
}: {
	boxes: Box[];
	current: Box | null;
	dims: Dims | null;
	onChoose: (choice: { box: Box | null; dims: Dims }) => void;
	onSaved: (box: Box) => void;
}) {
	const [value, setValue] = useState(current ? String(current.pin) : "");
	const [saveError, setSaveError] = useState<string | null>(null);
	// The side being typed but not locked in yet, for the hint below.
	const [typing, setTyping] = useState("");
	const [custom, setCustom] = useState(!current && dims !== null);
	const [sides, setSides] = useState(
		dims
			? [dims.lengthMm, dims.widthMm, dims.heightMm].map((mm) =>
					String(inches(mm)),
				)
			: [],
	);
	const match = boxes.find((b) => String(b.pin) === value);
	const parts = [...sides, typing].map(Number).filter((n) => n > 0);

	async function submit(final = parts) {
		if (custom && final.length === 4) {
			// A fourth number is a pin: save this size as a box (no empty
			// weight; add one in Settings if it matters) and ship in it.
			const [l, w, h, pin] = final;
			const taken = boxes.find((b) => b.pin === pin);
			if (taken) return setSaveError(`Pin ${pin} is already ${taken.name}`);
			try {
				const saved = await savePackage({
					data: {
						name: `${l} × ${w} × ${h}`,
						lengthIn: l,
						widthIn: w,
						heightIn: h,
						weightOz: 0,
						pin,
					},
				});
				onSaved(saved);
				onChoose({ box: saved, dims: saved });
			} catch (err) {
				setSaveError(err instanceof Error ? err.message : String(err));
			}
		} else if (custom && final.length === 3) {
			const [l, w, h] = final.map((n) => Math.round(n * MM_PER_INCH));
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
					{custom ? "Use a saved box" : "Custom size (C or Space)"}
				</button>
			</div>
			{custom ? (
				<SizeInput
					sides={sides}
					onSides={(next) => {
						setSides(next);
						setSaveError(null);
					}}
					onTyping={setTyping}
					onSubmit={(final) => submit(final)}
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
					onKeyDown={(e) => {
						if (e.key === "Enter") submit();
						// Space means this is a size, not a pin: what's typed so far
						// becomes the length.
						if (e.key === " ") {
							e.preventDefault();
							setSides(Number(value) > 0 ? [value] : []);
							setCustom(true);
						}
					}}
					className={cn(
						bigInput,
						"tracking-[0.4em] placeholder:text-[#e3e3e3]",
					)}
				/>
			)}
			<div className="flex h-8 items-center justify-center text-lg">
				{custom && saveError ? (
					<span className="text-critical-text">{saveError}</span>
				) : custom ? (
					parts.length === 4 ? (
						<span>
							Saves as box <span className="font-semibold">{parts[3]}</span>
							<span className="text-muted-foreground">
								{" "}
								· {parts.slice(0, 3).join(" × ")} in
							</span>
						</span>
					) : parts.length === 3 ? (
						<span>
							<span className="font-semibold">{parts.join(" × ")} in</span>
							<span className="text-muted-foreground">
								{" "}
								· <Key>Space</Key> and a pin saves it as a box
							</span>
						</span>
					) : (
						<span className="text-muted-foreground">
							Length <Key>Space</Key> width <Key>Space</Key> height
						</span>
					)
				) : match ? (
					<span>
						<span className="font-semibold">{match.name}</span>
						<span className="text-muted-foreground"> · {size(match)} in</span>
					</span>
				) : boxes.length === 0 ? (
					<span className="text-muted-foreground">
						No saved boxes yet. Type the length and press Space for a custom
						size.
					</span>
				) : value ? (
					<span className="text-critical-text">No box has that pin</span>
				) : null}
			</div>
		</div>
	);
}

// The fourth number, if typed, saves the size as a box under that pin.
const SIDE_LETTERS = ["L", "W", "H", "PIN"];

// Length, width, height in one box: space locks in a number and labels it
// (40 becomes 40L), backspace on an empty spot reopens the last one, Enter
// takes all three.
function SizeInput({
	sides,
	onSides,
	onTyping,
	onSubmit,
}: {
	sides: string[];
	onSides: (sides: string[]) => void;
	onTyping: (typing: string) => void;
	onSubmit: (final: number[]) => void;
}) {
	const [typing, setTypingHere] = useState("");
	const setTyping = (text: string) => {
		setTypingHere(text);
		onTyping(text);
	};
	const input = useRef<HTMLInputElement>(null);
	const done = sides.length === 4;
	const onPin = sides.length === 3;

	function lockIn() {
		if (Number(typing) > 0 && !done) {
			onSides([...sides, typing]);
			setTyping("");
		}
	}

	return (
		// biome-ignore lint/a11y/useKeyWithClickEvents: clicking just focuses the real input inside
		// biome-ignore lint/a11y/noStaticElementInteractions: same
		<div
			onClick={() => input.current?.focus()}
			className="flex h-24 w-full cursor-text items-center justify-center gap-5 rounded-xl border-2 border-input bg-white text-6xl font-bold tabular-nums focus-within:border-[#303030]"
		>
			{sides.map((side, i) => (
				<span key={SIDE_LETTERS[i]}>
					{side}
					<span className="ml-0.5 text-2xl font-semibold text-[#b5b5b5]">
						{SIDE_LETTERS[i]}
					</span>
				</span>
			))}
			{/* The side being typed shows its letter right after the cursor. */}
			<span className="inline-flex items-baseline">
				<input
					ref={input}
					// biome-ignore lint/a11y/noAutofocus: the step exists to type this
					autoFocus
					inputMode="decimal"
					aria-label="Box size in inches"
					value={typing}
					onChange={(e) =>
						setTyping(
							onPin
								? e.target.value.replace(/\D/g, "").slice(0, 3)
								: e.target.value.replace(/[^\d.]/g, ""),
						)
					}
					onKeyDown={(e) => {
						if ([" ", "x", "X", ","].includes(e.key)) {
							e.preventDefault();
							lockIn();
						}
						if (e.key === "Backspace" && typing === "" && sides.length > 0) {
							e.preventDefault();
							setTyping(sides[sides.length - 1]);
							onSides(sides.slice(0, -1));
						}
						if (e.key === "Enter") {
							const final = [...sides, ...(Number(typing) > 0 ? [typing] : [])]
								.map(Number)
								.filter((n) => n > 0);
							if (final.length >= 3) onSubmit(final);
						}
					}}
					// Exactly as wide as what's typed, so the letter hugs the number.
					className="min-w-[0.15em] bg-transparent outline-none [field-sizing:content]"
				/>
				{!done && (
					<span className="ml-0.5 text-2xl font-semibold text-[#b5b5b5]">
						{SIDE_LETTERS[sides.length]}
					</span>
				)}
			</span>
		</div>
	);
}

function WeightStep({
	initialGrams,
	hint,
	moreBoxes,
	onDraft,
	onSubmit,
	onAnother,
}: {
	initialGrams: number | null;
	hint: string | null;
	moreBoxes: boolean;
	onDraft: (grams: number | null) => void;
	onSubmit: (grams: number) => void;
	onAnother: (grams: number) => void;
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
						// + finishes this box and starts another.
						if (e.key === "+" || e.key === "=") {
							e.preventDefault();
							if (g) onAnother(g);
						}
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
				<Key>Tab</Key> switches to {unit === "oz" ? "pounds" : "ounces"} ·{" "}
				<span className={cn(moreBoxes && "font-semibold text-foreground")}>
					<Key>+</Key> another box
				</span>
			</p>
		</div>
	);
}

function InsureStep({
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
				{boxes > 1
					? `Insure these ${boxes} boxes? The amount is split between them.`
					: "Insure this package?"}
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
					setSelected((i) => Math.min(i + 1, rates.list.length - 1));
				}
				if (e.key === "ArrowUp") setSelected((i) => Math.max(i - 1, 0));
				if (e.key === "Enter") onBuy(rates.list[selected]);
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
	const [voiding, setVoiding] = useState<"ask" | "busy" | null>(null);
	const [voided, setVoided] = useState<string | null>(null);
	const [voidError, setVoidError] = useState<string | null>(null);
	const many = bought.boxes.length > 1;
	const handoff = bought.handoff;

	async function confirmVoid() {
		setVoiding("busy");
		setVoidError(null);
		try {
			const result = await voidLabel({
				data: { dispatchId: bought.dispatchId },
			});
			// Some refunds refused: stay here so voiding can be tried again.
			if (result.remaining > 0) {
				return setVoidError(result.notes.join(" "));
			}
			setVoided(
				[
					`${many ? "Labels" : "Label"} voided, refund ${result.refundStatus.toLowerCase()}.`,
					...result.notes,
				].join(" "),
			);
		} catch (err) {
			setVoidError(err instanceof Error ? err.message : String(err));
		} finally {
			setVoiding(null);
		}
	}

	if (voided) {
		return (
			<div className="flex flex-col items-center gap-4 py-4 text-center">
				<p className="text-3xl font-bold">{many ? "Labels" : "Label"} voided</p>
				<p className="text-lg text-muted-foreground">{voided}</p>
				<button
					ref={next}
					type="button"
					onClick={onNext}
					className="h-14 rounded-xl bg-[#303030] px-8 text-xl font-semibold text-white outline-none hover:bg-[#1a1a1a] focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
				>
					Next order
				</button>
			</div>
		);
	}

	return (
		<div className="flex flex-col gap-3">
			<div className="flex flex-col items-center gap-3 rounded-xl bg-success-surface px-6 py-8 text-center">
				<CircleCheck className="size-16 text-success-icon" />
				<p className="text-4xl font-bold">
					{many ? `${bought.boxes.length} labels bought` : "Label bought"}
				</p>
				<p className="text-xl">
					{bought.serviceName} ·{" "}
					<span className="font-semibold">{formatMoney(bought.cost)}</span>
				</p>
				{bought.test && (
					<Badge tone="info">Test label: it won't ship anything</Badge>
				)}
				{/* Every box's label. Only the first opens by itself (browsers
				    allow one new tab per key press), so the rest are links. */}
				<ul className="flex flex-col gap-1">
					{bought.boxes.map((b, i) => (
						<li key={b.id} className="flex items-center justify-center gap-3">
							{many && (
								<a
									href={labelPath(b.id)}
									target="_blank"
									rel="noreferrer"
									className={cn(
										"text-lg hover:underline",
										i === 0
											? "text-muted-foreground"
											: "font-semibold text-link",
									)}
								>
									{i === 0 ? "Box 1 (opened)" : `Print box ${i + 1}`}
								</a>
							)}
							{b.trackingNumber && (
								<span className="font-mono text-muted-foreground">
									{b.trackingNumber}
								</span>
							)}
						</li>
					))}
				</ul>
				{handoff?.sent && (
					<p className="text-lg font-semibold text-success-text">
						{handoff.message}
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
					{!many && bought.boxes[0] && (
						<a
							href={labelPath(bought.boxes[0].id)}
							target="_blank"
							rel="noreferrer"
							className="text-lg text-link hover:underline"
						>
							Open label again
						</a>
					)}
					{/* TikTok has no API to cancel its labels. */}
					{bought.provider === "tiktok" ? (
						<span className="text-lg text-muted-foreground">
							Cancel in TikTok Seller Center
						</span>
					) : voiding === "ask" ? (
						<button
							type="button"
							onClick={confirmVoid}
							className="text-lg font-semibold text-critical-text hover:underline"
						>
							Void and refund {formatMoney(bought.cost)}?
						</button>
					) : (
						<button
							type="button"
							disabled={voiding === "busy"}
							onClick={() => setVoiding("ask")}
							className="text-lg text-muted-foreground hover:underline"
						>
							{voiding === "busy"
								? "Voiding…"
								: many
									? "Void all labels"
									: "Void label"}
						</button>
					)}
				</div>
			</div>
			{handoff && !handoff.sent && (
				<Notice tone={bought.test ? "info" : "critical"}>
					{handoff.message}
					{!bought.test &&
						". Retry from the order page; it stays on To ship until then."}
				</Notice>
			)}
			{voidError && <Notice tone="critical">{voidError}</Notice>}
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
