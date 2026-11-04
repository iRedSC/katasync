import { CircleCheck, Send } from "lucide-react";
import {
	type FormEvent,
	type ReactNode,
	useEffect,
	useRef,
	useState,
} from "react";
import { Badge } from "#/components/page";
import { Notice } from "#/components/quick-ship/notice";
import { Spinner } from "#/components/quick-ship/spinner";
import type { Box } from "#/components/quick-ship/types";
import {
	GRAMS_PER_OUNCE,
	inches,
	MM_PER_INCH,
} from "#/components/quick-ship/units";
import { Button } from "#/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogHeader,
	DialogTitle,
} from "#/components/ui/dialog";
import { formatMoney } from "#/lib/format";
import { cn } from "#/lib/utils";
import { printLabels } from "#/printing/qz-client";
import {
	addressedBuy,
	addressedQuote,
	addressedVoid,
	listPackages,
} from "#/server/shipping";
import type { Rate } from "#/shipping/shippo";

type Quote = Awaited<ReturnType<typeof addressedQuote>>;
type Bought = Extract<
	Awaited<ReturnType<typeof addressedBuy>>,
	{ kind: "bought" }
>;
type Request = Parameters<typeof addressedQuote>[0]["data"];

// What the form shows under the fields. Prices belong to the exact request
// they were asked for, so editing anything drops them.
type Phase =
	| { kind: "editing" }
	| { kind: "pricing" }
	| { kind: "priced"; quote: Quote; key: string }
	| { kind: "buying"; quote: Quote; key: string; rate: Rate }
	| { kind: "bought"; bought: Bought; voiding: boolean }
	| { kind: "voided"; bought: Bought; refundStatus: string };

const blank = {
	name: "",
	street1: "",
	street2: "",
	city: "",
	state: "",
	zip: "",
	boxId: "custom",
	length: "",
	width: "",
	height: "",
	lb: "",
	oz: "",
};
type Fields = typeof blank;

const field =
	"h-9 w-full min-w-0 rounded-lg border border-input bg-white px-2.5 outline-none focus:border-ring";

// The form as the server takes it, or null while something is missing.
function requestOf(f: Fields, boxes: Box[]): Request | null {
	const t = (s: string) => s.trim();
	const saved = boxes.find((b) => String(b.id) === f.boxId) ?? null;
	const mm = (s: string) => Math.round(Number(s) * MM_PER_INCH);
	const dims = saved
		? [saved.lengthMm, saved.widthMm, saved.heightMm]
		: [mm(f.length), mm(f.width), mm(f.height)];
	const grams = Math.round(
		(Number(f.lb || 0) * 16 + Number(f.oz || 0)) * GRAMS_PER_OUNCE,
	);
	const state = t(f.state).toUpperCase();
	const zip = t(f.zip);
	if (
		!t(f.name) ||
		!t(f.street1) ||
		!t(f.city) ||
		!/^[A-Z]{2}$/.test(state) ||
		!/^\d{5}(-\d{4})?$/.test(zip) ||
		dims.some((d) => !(d > 0)) ||
		!(grams > 0)
	) {
		return null;
	}
	return {
		to: {
			name: t(f.name),
			street1: t(f.street1),
			street2: t(f.street2) || null,
			city: t(f.city),
			state,
			zip,
		},
		box: {
			packageId: saved?.id ?? null,
			lengthMm: dims[0],
			widthMm: dims[1],
			heightMm: dims[2],
			weightGrams: grams,
		},
	};
}

const why = (err: unknown) =>
	err instanceof Error ? err.message : "Something went wrong";

// A label to any address, for no order: who, box, weight, service. Nothing
// order-side happens; the label is kept on record and can be voided.
export function SendPackage() {
	const [open, setOpen] = useState(false);
	const [boxes, setBoxes] = useState<Box[]>([]);
	const [f, setF] = useState<Fields>(blank);
	const [phase, setPhase] = useState<Phase>({ kind: "editing" });
	const [error, setError] = useState<string | null>(null);
	const busy = phase.kind === "pricing" || phase.kind === "buying";
	// This purchase's name, kept until a clear answer: a retry after a lost
	// response settles the label already bought instead of buying another.
	const attemptId = useRef(crypto.randomUUID());
	const renew = () => {
		attemptId.current = crypto.randomUUID();
	};

	useEffect(() => {
		if (open) listPackages().then(setBoxes, () => {});
	}, [open]);

	const request = requestOf(f, boxes);
	const key = JSON.stringify(request);

	function set(name: keyof Fields, value: string) {
		if (busy) return;
		setF((old) => ({ ...old, [name]: value }));
		setError(null);
		if (phase.kind === "priced") setPhase({ kind: "editing" });
	}

	async function price(e: FormEvent) {
		e.preventDefault();
		if (!request || busy) return;
		setError(null);
		setPhase({ kind: "pricing" });
		try {
			const quote = await addressedQuote({ data: request });
			setPhase({ kind: "priced", quote, key });
		} catch (err) {
			setPhase({ kind: "editing" });
			setError(why(err));
		}
	}

	async function buy(rate: Rate) {
		if (phase.kind !== "priced" || !request || phase.key !== key) return;
		const { quote } = phase;
		setError(null);
		setPhase({ kind: "buying", quote, key, rate });
		try {
			const bought = await addressedBuy({
				data: {
					...request,
					attemptId: attemptId.current,
					choice: {
						carrier: rate.carrier,
						service: rate.service,
						total: rate.cost,
					},
				},
			});
			if (bought.kind === "unsure") {
				setPhase({ kind: "editing" });
				return setError(bought.message);
			}
			renew();
			setPhase({ kind: "bought", bought, voiding: false });
			printLabels([bought.shipmentId]);
		} catch (err) {
			// The server said no, so nothing was bought. A request that never
			// got an answer keeps its name, so pressing again can't buy twice.
			if (!(err instanceof TypeError)) renew();
			setPhase({ kind: "editing" });
			setError(why(err));
		}
	}

	async function voidIt(bought: Bought) {
		setError(null);
		setPhase({ kind: "bought", bought, voiding: true });
		// Nothing else can start while voiding, so this is still the same label.
		try {
			const { refundStatus } = await addressedVoid({
				data: { dispatchId: bought.dispatchId },
			});
			setPhase({ kind: "voided", bought, refundStatus });
		} catch (err) {
			setPhase({ kind: "bought", bought, voiding: false });
			setError(why(err));
		}
	}

	function another() {
		setF(blank);
		setError(null);
		setPhase({ kind: "editing" });
	}

	const done = phase.kind === "bought" || phase.kind === "voided";
	// Money is moving: the dialog stays until it's settled.
	const locked =
		phase.kind === "buying" || (phase.kind === "bought" && phase.voiding);
	const saved = boxes.find((b) => String(b.id) === f.boxId);

	return (
		<>
			<Button variant="outline" size="sm" onClick={() => setOpen(true)}>
				<Send />
				Send a package
			</Button>
			<Dialog
				open={open}
				onOpenChange={(next) => {
					// The result stays until Send another, so closing never loses it.
					if (!next && locked) return;
					setOpen(next);
				}}
			>
				<DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto bg-card sm:max-w-lg">
					<DialogHeader>
						<DialogTitle>Send a package</DialogTitle>
					</DialogHeader>
					{done ? (
						<Done
							phase={phase}
							onVoid={voidIt}
							onAnother={another}
							error={error}
						/>
					) : (
						<form onSubmit={price} className="flex flex-col gap-4">
							<fieldset disabled={busy} className="flex flex-col gap-2">
								<Label text="Recipient">
									<input
										autoFocus
										className={field}
										value={f.name}
										onChange={(e) => set("name", e.target.value)}
										autoComplete="off"
									/>
								</Label>
								<Label text="Street">
									<input
										className={field}
										value={f.street1}
										onChange={(e) => set("street1", e.target.value)}
										autoComplete="off"
									/>
								</Label>
								<Label text="Apt, suite">
									<input
										className={field}
										value={f.street2}
										onChange={(e) => set("street2", e.target.value)}
										autoComplete="off"
									/>
								</Label>
								<div className="grid grid-cols-[1fr_4rem_6rem] gap-2">
									<Label text="City">
										<input
											className={field}
											value={f.city}
											onChange={(e) => set("city", e.target.value)}
											autoComplete="off"
										/>
									</Label>
									<Label text="State">
										<input
											className={cn(field, "uppercase")}
											value={f.state}
											maxLength={2}
											onChange={(e) => set("state", e.target.value)}
											autoComplete="off"
										/>
									</Label>
									<Label text="ZIP">
										<input
											className={field}
											value={f.zip}
											inputMode="numeric"
											maxLength={10}
											onChange={(e) => set("zip", e.target.value)}
											autoComplete="off"
										/>
									</Label>
								</div>
							</fieldset>

							<fieldset disabled={busy} className="flex flex-col gap-2">
								<Label text="Box">
									<select
										className={field}
										value={f.boxId}
										onChange={(e) => set("boxId", e.target.value)}
									>
										<option value="custom">Custom size</option>
										{boxes.map((b) => (
											<option key={b.id} value={String(b.id)}>
												{b.name ? `${b.name} · ` : ""}
												{inches(b.lengthMm)} × {inches(b.widthMm)} ×{" "}
												{inches(b.heightMm)} in
											</option>
										))}
									</select>
								</Label>
								{!saved && (
									<div className="grid grid-cols-3 gap-2">
										{(["length", "width", "height"] as const).map((side) => (
											<Label
												key={side}
												text={`${side[0].toUpperCase()}${side.slice(1)}, in`}
											>
												<input
													className={field}
													inputMode="decimal"
													value={f[side]}
													onChange={(e) => set(side, e.target.value)}
												/>
											</Label>
										))}
									</div>
								)}
								<div className="grid grid-cols-2 gap-2">
									<Label text="Weight, lb">
										<input
											className={field}
											inputMode="decimal"
											value={f.lb}
											onChange={(e) => set("lb", e.target.value)}
										/>
									</Label>
									<Label text="oz">
										<input
											className={field}
											inputMode="decimal"
											value={f.oz}
											onChange={(e) => set("oz", e.target.value)}
										/>
									</Label>
								</div>
							</fieldset>

							{phase.kind === "priced" || phase.kind === "buying" ? (
								<Rates
									quote={phase.quote}
									buying={phase.kind === "buying" ? phase.rate : null}
									onBuy={buy}
								/>
							) : (
								<Button
									type="submit"
									disabled={!request || busy}
									className="h-10"
								>
									{phase.kind === "pricing" ? <Spinner /> : "Get rates"}
								</Button>
							)}
							{error && <Notice tone="critical">{error}</Notice>}
						</form>
					)}
				</DialogContent>
			</Dialog>
		</>
	);
}

function Label({ text, children }: { text: string; children: ReactNode }) {
	return (
		// biome-ignore lint/a11y/noLabelWithoutControl: every caller nests its input
		<label className="flex flex-col gap-1 text-[0.8125rem] text-muted-foreground">
			{text}
			{children}
		</label>
	);
}

// Cheapest first; a click buys.
function Rates({
	quote,
	buying,
	onBuy,
}: {
	quote: Quote;
	buying: Rate | null;
	onBuy: (rate: Rate) => void;
}) {
	return (
		<div className="flex flex-col gap-2">
			{quote.test && (
				<Badge tone="info">Test key: labels won't ship anything</Badge>
			)}
			{quote.rates.length === 0 && (
				<Notice tone="critical">
					{quote.notes.join(" ") ||
						"No carrier offers this box to this address"}
				</Notice>
			)}
			<ul className="flex flex-col gap-1.5">
				{quote.rates.map((r) => (
					<li key={r.id}>
						<button
							type="button"
							disabled={buying !== null}
							onClick={() => onBuy(r)}
							className={cn(
								"flex w-full items-center justify-between rounded-lg border border-input bg-white px-3 py-2 text-left outline-none hover:border-primary focus-visible:border-primary disabled:opacity-50",
								buying?.id === r.id && "border-primary opacity-100!",
							)}
						>
							<span>
								{r.serviceName}
								{r.days !== null && (
									<span className="text-muted-foreground">
										{" "}
										· {r.days} {r.days === 1 ? "day" : "days"}
									</span>
								)}
							</span>
							<span className="font-semibold tabular-nums">
								{buying?.id === r.id ? <Spinner /> : formatMoney(r.cost)}
							</span>
						</button>
					</li>
				))}
			</ul>
		</div>
	);
}

function Done({
	phase,
	onVoid,
	onAnother,
	error,
}: {
	phase: Extract<Phase, { kind: "bought" | "voided" }>;
	onVoid: (bought: Bought) => void;
	onAnother: () => void;
	error: string | null;
}) {
	const { bought } = phase;
	const [asking, setAsking] = useState(false);
	const voided = phase.kind === "voided";
	const voiding = phase.kind === "bought" && phase.voiding;
	return (
		<div className="flex flex-col gap-3">
			<div
				className={cn(
					"flex flex-col items-center gap-2 rounded-xl px-6 py-6 text-center",
					voided ? "bg-muted" : "bg-success-surface",
				)}
			>
				{!voided && <CircleCheck className="size-12 text-success-icon" />}
				<p className="text-2xl font-bold">
					{voided ? "Label voided" : "Label bought"}
				</p>
				<p>
					{bought.sentTo.name}, {bought.sentTo.city} {bought.sentTo.state}
				</p>
				<p className={cn(voided && "line-through text-muted-foreground")}>
					{bought.serviceName} ·{" "}
					<span className="font-semibold">{formatMoney(bought.cost)}</span>
				</p>
				{voided && (
					<p className="text-muted-foreground">
						Refund {phase.refundStatus.toLowerCase()}
					</p>
				)}
				{bought.trackingNumber && !voided && (
					<span className="font-mono text-muted-foreground">
						{bought.trackingNumber}
					</span>
				)}
				{bought.test && !voided && (
					<Badge tone="info">Test label: it won't ship anything</Badge>
				)}
			</div>
			<div className="flex items-center justify-center gap-4">
				<Button onClick={onAnother} disabled={voiding}>
					Send another
				</Button>
				{!voided && (
					<>
						<button
							type="button"
							onClick={() => printLabels([bought.shipmentId])}
							className="text-link hover:underline"
						>
							Print again
						</button>
						{asking && !voiding ? (
							<button
								type="button"
								onClick={() => {
									setAsking(false);
									onVoid(bought);
								}}
								className="font-semibold text-critical-text hover:underline"
							>
								Void and refund {formatMoney(bought.cost)}?
							</button>
						) : (
							<button
								type="button"
								disabled={voiding}
								onClick={() => setAsking(true)}
								className="text-muted-foreground hover:underline"
							>
								{voiding ? "Voiding…" : "Void label"}
							</button>
						)}
					</>
				)}
			</div>
			{error && <Notice tone="critical">{error}</Notice>}
		</div>
	);
}
