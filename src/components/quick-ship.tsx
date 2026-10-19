import { type KeyboardEvent, useEffect, useRef, useState } from "react";
import { MAX_BOXES } from "#/components/quick-ship/constants";
import { DoneStep } from "#/components/quick-ship/done-step";
import { ExternalStep } from "#/components/quick-ship/external-step";
import { startsHazmat } from "#/components/quick-ship/hazmat";
import { splitInsurance } from "#/components/quick-ship/insurance";
import { Key } from "#/components/quick-ship/key";
import { Notice } from "#/components/quick-ship/notice";
import { OrderSummary } from "#/components/quick-ship/order-summary";
import { PackageStep } from "#/components/quick-ship/package-step";
import { PinStep } from "#/components/quick-ship/pin-step";
import { RatesStep } from "#/components/quick-ship/rates-step";
import { StepStrip, stepsFor } from "#/components/quick-ship/step-strip";
import type {
	Bought,
	Box,
	Dims,
	Extras,
	Found,
	Packed,
	Rates,
	Step,
} from "#/components/quick-ship/types";
import { useQuickShipCache } from "#/components/quick-ship/use-quick-ship-cache";
import { WeightStep } from "#/components/quick-ship/weight-step";
import { Dialog, DialogContent, DialogTitle } from "#/components/ui/dialog";
import { optimism } from "#/lib/optimism";
import { printLabels } from "#/printing/qz-client";
import { listPackages, quickShipBuy } from "#/server/shipping";
import type { ShipmentPlan } from "#/shipping/quick-ship";
import type { Rate } from "#/shipping/shippo";

const noExtras: Extras = { insure: null, signature: false };

// Each plan starts uninsured (insurance is only recommended), with a
// signature only when one is required. Going back to fix a box or weight
// keeps whatever was changed on the service step.
const startingExtras = (plan: ShipmentPlan): Extras => ({
	insure: null,
	signature: plan.signatureRequired !== null,
});

const sameExtras = (a: Extras, b: Extras) =>
	a.insure === b.insure && a.signature === b.signature;

// Opens quick ship already on this order, past the pin step (the order
// page's Ship button).
export function openQuickShip(pin: number) {
	window.dispatchEvent(new CustomEvent("quick-ship", { detail: pin }));
}

// Ctrl+Space anywhere: order pin, box, weight, service. Tab on the box step
// adds other orders to the same address to this box; + on the weight step
// adds another box; on the service step, Tab insures and S asks for a
// signature. Enter moves forward, Escape steps
// back. The order loads as the third digit is typed, and prices load while
// the weight is still on screen, so Enter rarely waits.
export function QuickShip() {
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
	const [hazmat, setHazmat] = useState(false);
	const [weightGrams, setWeightGrams] = useState<number | null>(null);
	const [draftGrams, setDraftGrams] = useState<number | null>(null);
	const [extras, setExtras] = useState<Extras>(noExtras);
	// The prices shown, and the extras they were quoted with.
	const [rates, setRates] = useState<(Rates & { for: Extras }) | null>(null);
	const [bought, setBought] = useState<Bought | null>(null);

	// Lookups, plans, and prices already asked for, so asking again is
	// instant.
	const { clear, clearPrices, lookUp, planFor, priceFor } =
		useQuickShipCache(plan);
	const latest = useRef(0);

	function reset() {
		setStep("pin");
		setError(null);
		setFound(null);
		setPlan(null);
		setPacked([]);
		setBox(null);
		setDims(null);
		setHazmat(false);
		setWeightGrams(null);
		setDraftGrams(null);
		setExtras(noExtras);
		setRates(null);
		setBought(null);
		clear();
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

	// Every box with its weight, the one being entered last.
	const allBoxes = (grams: number | null): Packed[] =>
		dims && grams
			? [...packed, { box, dims, weightGrams: grams, hazmat }]
			: packed;

	// Ask for prices as soon as a weight sits still for a moment, with the
	// extras the service step will show.
	// biome-ignore lint/correctness/useExhaustiveDependencies: priceFor reads the same state
	useEffect(() => {
		if (step !== "weight" || !draftGrams || !plan) return;
		const timer = setTimeout(() => {
			priceFor(allBoxes(draftGrams), extras)?.catch(() => {});
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
			setHazmat(last.hazmat);
			setWeightGrams(last.weightGrams);
			setDraftGrams(last.weightGrams);
			return setStep("weight");
		}
		const order: Step[] = ["pin", "package", "weight", "rates"];
		setStep(order[order.indexOf(step) - 1]);
	};

	// Starts a box from the matching box of the last time these contents
	// shipped, if there was one.
	function suggestBox(next: ShipmentPlan, index: number, known = boxes) {
		const last = next.last?.[index] ?? null;
		const lastBox = known.find((b) => b.id === last?.packageId) ?? null;
		setBox(lastBox);
		setDims(last ?? lastBox);
		setHazmat(startsHazmat(next, index));
	}

	// Ctrl+H on the box step. Prices for the other setting don't apply.
	function toggleHazmat() {
		if (step !== "package" || busy) return;
		setHazmat((h) => !h);
	}

	async function choosePin(pin: number) {
		const result = await run(() => lookUp(pin));
		if (result === undefined) return;
		if (result === null) return setError(`No order to ship has pin ${pin}`);
		setFound(result);
		setPlan(result.plan);
		setExtras(startingExtras(result.plan));
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
	const choosePackageRef = useRef((_: { box: Box | null; dims: Dims }) => {});

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
		setExtras(startingExtras(next));
		setRates(null);
		latest.current++;
		if (next.last) suggestBox(next, 0);
	}

	function choosePackage(next: { box: Box | null; dims: Dims }) {
		// A box saved after leaving the step, or while new contents load,
		// doesn't count.
		if (!plan || busy || step !== "package") return;
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

	choosePackageRef.current = choosePackage;

	// + on the weight step: this box is done, on to the next.
	function anotherBox(grams: number) {
		if (!dims || !plan) return;
		if (packed.length + 1 >= MAX_BOXES) {
			return setError(`At most ${MAX_BOXES} boxes in one shipment`);
		}
		setPacked([...packed, { box, dims, weightGrams: grams, hazmat }]);
		suggestBox(plan, packed.length + 1);
		setWeightGrams(null);
		setDraftGrams(null);
		setError(null);
		setStep("package");
	}

	function chooseWeight(grams: number) {
		if (!plan) return;
		setWeightGrams(grams);
		showRates(allBoxes(grams), extras);
	}

	// keep: leave the old prices up, dimmed, while new extras are priced.
	async function showRates(list: Packed[], next: Extras, keep = false) {
		const pending = priceFor(list, next);
		if (!pending) return;
		const mine = ++latest.current;
		setStep("rates");
		if (!keep) setRates(null);
		const result = await run(() => pending);
		if (result && mine === latest.current) setRates({ ...result, for: next });
	}

	function changeExtras(next: Extras) {
		setExtras(next);
		showRates(allBoxes(weightGrams), next, true);
	}

	async function buy(quote: Rate) {
		const list = allBoxes(weightGrams);
		// Only at the price on screen: prices for the extras chosen.
		if (!plan || list.length === 0 || busy || !rates) return;
		if (!sameExtras(rates.for, extras)) return;
		const parts = splitInsurance(extras.insure, list.length);
		// Buys a real label, so it stays busy until the reload shows it.
		const r = await run(() =>
			optimism.change({
				send: () =>
					quickShipBuy({
						data: {
							orderIds: plan.orderIds,
							contentsKey: plan.contentsKey,
							signature: extras.signature,
							boxes: list.map((p, i) => ({
								packageId: p.box?.id ?? null,
								...p.dims,
								weightGrams: p.weightGrams,
								insureAmount: parts[i],
								hazmat: p.hazmat,
							})),
							choice: {
								carrier: quote.carrier,
								service: quote.service,
								id: quote.id,
							},
						},
					}),
			}),
		);
		if (!r) return;
		const result = r.value;
		if (result.failed) {
			// A label still live blocks buying again; it has to be voided.
			if (result.boxes.length > 0) {
				setRates(null);
				return setError(result.failed);
			}
			// Everything was refunded: show fresh prices to try again, keeping
			// the explanation on screen.
			clearPrices();
			await showRates(list, extras);
			return setError(result.failed);
		}
		setBought(result);
		setStep("done");
		printLabels(result.boxes.map((b) => b.id));
	}

	const external = found?.external ?? null;
	const count = packed.length + (dims ? 1 : 0);
	const steps = stepsFor({
		found,
		plan,
		step,
		packed,
		box,
		dims,
		hazmat,
		weightGrams,
		bought,
		count,
	});

	return (
		<Dialog open={open} onOpenChange={setOpen}>
			<DialogContent
				// Never taller than the screen: a long order scrolls instead of
				// pushing the steps off the top.
				className="max-h-[calc(100dvh-2rem)] grid-cols-[minmax(0,1fr)] gap-0 overflow-y-auto bg-card p-0 sm:max-w-2xl"
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
					// Ctrl, not a letter: the box step types box names. Also keeps
					// the browser's history page from opening.
					if (e.ctrlKey && e.key.toLowerCase() === "h" && step === "package") {
						e.preventDefault();
						toggleHazmat();
					}
					if (
						// Tab, not a letter: the box step types box names.
						e.key === "Tab" &&
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
								Already labeled. Void it on the order page to change boxes.
							</Notice>
						)}

					{step === "package" &&
						found &&
						!external &&
						found.liveDispatchId === null && (
							<PackageStep
								// A fresh step for each box, and again when orders join or
								// leave the box, starting from that box's suggestion.
								key={`${packed.length}:${plan?.orderIds.join(",")}`}
								boxes={boxes}
								current={box}
								dims={dims}
								hazmat={hazmat}
								onHazmat={toggleHazmat}
								// Through the ref: saving a custom box finishes later, and
								// must reach the current choosePackage, not this render's.
								onChoose={(next) => choosePackageRef.current(next)}
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

					{step === "rates" && !(error && !rates) && (
						<RatesStep
							rates={rates}
							stale={rates !== null && !sameExtras(rates.for, extras)}
							boxes={count}
							busy={busy}
							offer={{
								total: plan?.total ?? 0,
								recommendInsurance: plan?.insure ?? false,
								signatureRequired: plan?.signatureRequired ?? null,
								unavailable: plan?.extras
									? null
									: "TikTok buys this label, and TikTok's labels can't add insurance or a signature",
							}}
							extras={extras}
							onExtras={changeExtras}
							onBuy={buy}
						/>
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
