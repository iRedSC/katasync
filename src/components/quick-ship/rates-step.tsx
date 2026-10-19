import { type KeyboardEvent, useEffect, useRef, useState } from "react";
import { Badge } from "#/components/page";
import { Truncate } from "#/components/truncate";
import { formatMoney } from "#/lib/format";
import { cn } from "#/lib/utils";
import type { Rate } from "#/shipping/shippo";
import { InsuranceField, SignatureToggle } from "./extras";
import {
	insuranceText,
	parseInsurance,
	toggleFullCoverage,
	typeInsurance,
} from "./insurance";
import { Key } from "./key";
import { Notice } from "./notice";
import { Spinner } from "./spinner";
import type { Extras, Rates } from "./types";

// Insurance and signature for a Shippo label, and what the order says
// about them. Null for labels that take neither (TikTok's).
export type ExtrasOffer = {
	total: number;
	// Big or flagged orders start insured for their full value, with the
	// field showing; others keep it out of the way until Tab.
	suggestInsurance: boolean;
	// Why a signature can't be turned off, if it can't.
	signatureRequired: string | null;
};

const serviceKey = (r: Rate) => `${r.carrier}:${r.service}`;
// A typed amount waits this long for more typing before prices update.
const SETTLE_MS = 400;

export function RatesStep({
	rates,
	stale,
	boxes,
	busy,
	offer,
	extras,
	onExtras,
	onBuy,
}: {
	rates: Rates | null;
	// The prices shown are for other extras; new ones are on the way.
	stale: boolean;
	boxes: number;
	busy: boolean;
	offer: ExtrasOffer | null;
	extras: Extras;
	onExtras: (next: Extras) => void;
	onBuy: (quote: Rate) => void;
}) {
	const [selected, setSelected] = useState(0);
	const [draft, setDraft] = useState(insuranceText(extras.insure));
	const [showInsurance, setShowInsurance] = useState(
		extras.insure !== null || Boolean(offer?.suggestInsurance),
	);
	const typed = parseInsurance(draft);
	// Typed but not priced yet: Enter prices it first.
	const unsettled = typed !== extras.insure;
	const ready = rates !== null && !stale && !unsettled && !busy;

	const root = useRef<HTMLDivElement>(null);
	const input = useRef<HTMLInputElement>(null);
	const options = useRef<HTMLDivElement>(null);
	const chosen = useRef<string | null>(null);

	// New prices keep the service that was highlighted, if it's still
	// offered; else start from the top.
	// biome-ignore lint/correctness/useExhaustiveDependencies: on each new list
	useEffect(() => {
		if (!rates) return;
		const i = rates.list.findIndex((r) => serviceKey(r) === chosen.current);
		moveTo(Math.max(i, 0));
		if (!showInsurance) root.current?.focus();
	}, [rates]);

	// biome-ignore lint/correctness/useExhaustiveDependencies: prices the typed amount once typing stops
	useEffect(() => {
		if (!unsettled) return;
		const timer = setTimeout(
			() => onExtras({ ...extras, insure: typed }),
			SETTLE_MS,
		);
		return () => clearTimeout(timer);
	}, [draft]);

	function moveTo(i: number) {
		setSelected(i);
		chosen.current = rates?.list[i] ? serviceKey(rates.list[i]) : null;
		// Only five services fit; keep the arrow-key choice in view.
		options.current?.children[i]?.scrollIntoView({ block: "nearest" });
	}

	function onKeyDown(e: KeyboardEvent) {
		const list = rates?.list ?? [];
		if (e.key === "ArrowDown" || e.key === "ArrowUp") {
			e.preventDefault();
			const step = e.key === "ArrowDown" ? 1 : -1;
			moveTo(Math.min(Math.max(selected + step, 0), list.length - 1));
		}
		if (!offer) {
			if (e.key === "Enter" && ready && list[selected]) onBuy(list[selected]);
			return;
		}
		if (e.key === "Tab") {
			e.preventDefault();
			// The first Tab brings the field out; after that it toggles.
			if (!showInsurance) return setShowInsurance(true);
			const next = toggleFullCoverage(draft, offer.total);
			setDraft(next);
			onExtras({ ...extras, insure: parseInsurance(next) });
		}
		if (e.key.toLowerCase() === "s" && !e.ctrlKey && !e.metaKey) {
			e.preventDefault();
			toggleSignature();
		}
		if (e.key === "Enter") {
			if (unsettled) onExtras({ ...extras, insure: typed });
			else if (ready && list[selected]) onBuy(list[selected]);
		}
	}

	function toggleSignature() {
		// Locked on: the reason is on screen under the toggle.
		if (offer?.signatureRequired) return;
		onExtras({ insure: typed, signature: !extras.signature });
	}

	const heading = busy
		? stale || unsettled || !rates
			? "Updating prices…"
			: boxes > 1
				? `Buying ${boxes} labels…`
				: "Buying label…"
		: unsettled
			? "Enter updates prices"
			: boxes > 1
				? `Enter buys ${boxes} labels, one per box`
				: "Enter buys the label";

	return (
		<div
			ref={root}
			role="listbox"
			aria-label="Services"
			tabIndex={0}
			className="flex flex-col gap-2 outline-none"
			onKeyDown={onKeyDown}
		>
			{offer && (
				<>
					<div className="flex gap-2">
						{showInsurance ? (
							<InsuranceField
								text={draft}
								total={offer.total}
								boxes={boxes}
								input={input}
								onText={(t) => setDraft(typeInsurance(t))}
							/>
						) : (
							<p className="flex h-16 flex-1 items-center gap-2 px-1 text-muted-foreground">
								Not insured · <Key>Tab</Key> to insure
							</p>
						)}
						<SignatureToggle
							on={extras.signature}
							locked={offer.signatureRequired !== null}
							onToggle={toggleSignature}
						/>
					</div>
					{offer.signatureRequired && (
						<p className="text-sm text-muted-foreground">
							Signature required: {offer.signatureRequired}.
						</p>
					)}
				</>
			)}

			{!rates ? (
				<div className="flex h-40 items-center justify-center gap-3 text-xl text-muted-foreground">
					<Spinner /> Getting prices
				</div>
			) : rates.list.length === 0 ? (
				<Notice tone="critical">
					{boxes > 1
						? "No service ships every one of these boxes."
						: "No services available."}
					{rates.notes.length > 0 && ` ${rates.notes.join(" ")}`}
				</Notice>
			) : (
				<>
					<div className="flex items-baseline justify-between">
						<p className="flex items-center gap-2 text-xl font-semibold">
							{busy && (stale || unsettled) && <Spinner />}
							{heading}
						</p>
						{rates.test && <Badge tone="info">Test labels</Badge>}
					</div>
					<div
						ref={options}
						className={cn(
							"flex max-h-[22rem] flex-col gap-2 overflow-y-auto",
							(stale || unsettled) && "opacity-50",
						)}
					>
						{rates.list.map((r, i) => (
							<button
								key={r.id}
								type="button"
								tabIndex={-1}
								disabled={!ready}
								onMouseMove={() => moveTo(i)}
								onClick={() => onBuy(r)}
								className={cn(
									"flex h-16 shrink-0 items-center justify-between rounded-xl border-2 px-5 text-left",
									i === selected
										? "border-primary bg-primary text-primary-foreground"
										: "border-border hover:bg-subtle",
									busy && !stale && i !== selected && "opacity-40",
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
												i === selected
													? "text-white/70"
													: "text-muted-foreground"
											}
										>
											{r.days} {r.days === 1 ? "day" : "days"}
										</span>
									)}
								</span>
								<span className="flex items-center gap-3 text-3xl font-bold tabular-nums">
									{busy && !stale && !unsettled && i === selected && (
										<Spinner />
									)}
									{formatMoney(r.cost)}
								</span>
							</button>
						))}
					</div>
				</>
			)}
		</div>
	);
}
