import { Loader2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { formatCents, parseCents } from "#/banking/money";
import { Badge } from "#/components/page";
import { shake } from "#/components/shake";
import { Button } from "#/components/ui/button";
import { formatDate } from "#/lib/format";
import { cn } from "#/lib/utils";
import { type BankMatchOptions, getMatchOptions } from "#/server/banking";
import { MARKET_STATUS } from "./states";

type Load =
	| { kind: "loading" }
	| { kind: "failed"; problem: string }
	| { kind: "ready"; options: BankMatchOptions };

export type PartInput = {
	target: { kind: "payout"; id: number };
	amountCents: number;
};

export function AllocateForm({
	transactionId,
	onConfirm,
}: {
	transactionId: number;
	onConfirm: (parts: PartInput[]) => Promise<string | null>;
}) {
	const [load, setLoad] = useState<Load>({ kind: "loading" });
	const [picked, setPicked] = useState<Map<number, string>>(new Map());
	const [problem, setProblem] = useState<string | null>(null);
	const [sending, setSending] = useState(false);
	const box = useRef<HTMLDivElement>(null);

	useEffect(() => {
		let live = true;
		setLoad({ kind: "loading" });
		setPicked(new Map());
		getMatchOptions({ data: { transactionId } })
			.then((options) => {
				if (!live) return;
				setLoad(
					options
						? { kind: "ready", options }
						: { kind: "failed", problem: "This bank row is gone" },
				);
			})
			.catch(
				(e: Error) => live && setLoad({ kind: "failed", problem: e.message }),
			);
		return () => {
			live = false;
		};
	}, [transactionId]);

	if (load.kind === "loading")
		return (
			<Loader2 className="mx-auto mt-8 size-5 animate-spin text-muted-foreground" />
		);
	if (load.kind === "failed")
		return <p className="text-critical-text">{load.problem}</p>;
	const { bank, candidates, suggestions, ambiguous } = load.options;
	const money = (c: number) => formatCents(c, bank.currency);
	const parts = [...picked].map(([id, text]) => ({
		id,
		parsed: parseCents(text, bank.currency),
	}));
	const sum = parts.reduce((s, p) => s + (p.parsed.ok ? p.parsed.value : 0), 0);
	const left = bank.amountCents - sum;
	const readable = parts.every((p) => p.parsed.ok && p.parsed.value !== 0);
	const ready = parts.length > 0 && readable && left === 0 && !sending;
	const label = new Map(candidates.map((c) => [c.ref.id, c.label]));

	const toggle = (id: number, remaining: number) => {
		const next = new Map(picked);
		if (next.has(id)) next.delete(id);
		else {
			const room =
				Math.sign(left) === Math.sign(remaining)
					? Math.min(Math.abs(left), Math.abs(remaining))
					: 0;
			next.set(id, ((Math.sign(bank.amountCents) * room) / 100).toFixed(2));
		}
		setPicked(next);
		setProblem(null);
	};

	async function confirm() {
		if (!ready) return;
		setSending(true);
		const refused = await onConfirm(
			parts.map((p) => ({
				target: { kind: "payout", id: p.id },
				amountCents: p.parsed.ok ? p.parsed.value : 0,
			})),
		);
		setSending(false);
		if (refused) {
			setProblem(refused);
			shake(box.current);
		}
	}

	return (
		<div ref={box} className="flex flex-col gap-4">
			{suggestions.length > 0 && (
				<div className="flex flex-col gap-2">
					<h3 className="text-xs font-medium text-muted-foreground">
						Fits the amount{" "}
						{ambiguous && <Badge tone="warning">More than one fits</Badge>}
					</h3>
					{suggestions.map((s) => (
						<button
							key={s.parts.map((p) => p.target.id).join("-")}
							type="button"
							onClick={() => {
								setPicked(
									new Map(
										s.parts.map((p) => [
											p.target.id,
											(p.amountCents / 100).toFixed(2),
										]),
									),
								);
								setProblem(null);
							}}
							className="flex items-center gap-2 rounded-lg bg-subtle px-3 py-2 text-left hover:bg-surface-strong"
						>
							<span className="flex-1 truncate">
								{s.parts.map((p) => label.get(p.target.id)).join(" + ")}
							</span>
							{s.referenced && (
								<Badge tone="success">Reference in description</Badge>
							)}
						</button>
					))}
				</div>
			)}
			{candidates.length === 0 ? (
				<p className="text-muted-foreground">
					No payouts in {bank.currency} near this date with anything left to
					match.
				</p>
			) : (
				<ul className="flex flex-col divide-y rounded-lg border">
					{candidates.map((c) => {
						const on = picked.has(c.ref.id);
						return (
							<li
								key={c.ref.id}
								className={cn(
									"flex items-center gap-3 px-3 py-2",
									on && "bg-subtle",
								)}
							>
								<input
									type="checkbox"
									checked={on}
									onChange={() => toggle(c.ref.id, c.remainingCents)}
									aria-label={c.label}
								/>
								<div className="min-w-0 flex-1">
									<div className="truncate font-medium">{c.label}</div>
									<div className="flex items-center gap-2 text-xs text-muted-foreground">
										{formatDate(c.on)}
										<span>
											{c.days === 0
												? "same day"
												: `${Math.abs(c.days)}d ${c.days > 0 ? "before" : "after"}`}
										</span>
										<Badge tone={MARKET_STATUS[c.status]?.tone}>
											{MARKET_STATUS[c.status]?.label ?? c.status}
										</Badge>
									</div>
								</div>
								{on ? (
									<input
										value={picked.get(c.ref.id) ?? ""}
										onChange={(e) => {
											setPicked(new Map(picked).set(c.ref.id, e.target.value));
											setProblem(null);
										}}
										inputMode="decimal"
										aria-label={`Amount for ${c.label}`}
										aria-invalid={
											!parseCents(picked.get(c.ref.id) ?? "", bank.currency).ok
										}
										className="h-8 w-28 rounded-lg border border-input bg-white px-2 text-right tabular-nums outline-none focus:border-ring aria-invalid:border-critical-text"
									/>
								) : (
									<span className="w-28 text-right text-muted-foreground tabular-nums">
										{money(c.remainingCents)}
										{c.allocatedCents !== 0 && (
											<span className="block text-xs">
												of {money(c.amountCents)}
											</span>
										)}
									</span>
								)}
							</li>
						);
					})}
				</ul>
			)}
			<div className="flex items-center gap-3">
				<span
					className={cn(
						"flex-1 tabular-nums transition-colors",
						left === 0 && parts.length > 0
							? "text-success-text"
							: left !== 0 && sum !== 0
								? "text-warning-text"
								: "text-muted-foreground",
					)}
				>
					{left === 0 && parts.length > 0 ? "All of it" : `${money(left)} left`}
				</span>
				<Button onClick={confirm} disabled={!ready}>
					{sending && <Loader2 className="animate-spin" />}
					Confirm match
				</Button>
			</div>
			{problem && <p className="text-xs text-critical-text">{problem}</p>}
		</div>
	);
}
