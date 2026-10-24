import {
	Check,
	ChevronRight,
	Clock,
	DollarSign,
	Hash,
	MessageSquare,
	X,
} from "lucide-react";
import { useState } from "react";
import { Card } from "#/components/page";
import { Button } from "#/components/ui/button";
import { Tip } from "#/components/ui/tooltip";
import { optimism } from "#/lib/optimism";
import { offerUndo } from "#/lib/undo";
import { cn } from "#/lib/utils";
import type { Flag } from "#/purchasing/flags";
import type { FlagInput } from "#/purchasing/inbox/ai-filing-shapes";
import { reopenPoFlag, resolvePoFlag } from "#/server/purchasing";

// Flags on a PO: what a supplier's email says should change, each a row
// that shows the line as it is and as the flag says. Apply makes the change,
// dismiss leaves the line alone; both can be undone. A note only dismisses.

const ICON = {
	price: DollarSign,
	quantity: Hash,
	back_order: Clock,
	note: MessageSquare,
} as const;

const money = (n: number | null) => (n === null ? "no price" : `$${n}`);

// What the flag changes: from the line now to what it says.
function Change({ flag: f }: { flag: Flag }) {
	if (f.kind === "price")
		return (
			<span className="tabular-nums">
				{money(f.unitCost)} → <b>{money(f.value)}</b>
			</span>
		);
	if (f.kind === "quantity")
		return (
			<span className="tabular-nums">
				{f.quantity ?? "?"} → <b>{f.value}</b> {f.unit}
			</span>
		);
	if (f.kind === "back_order")
		return <span className="text-warning-text">Back-ordered</span>;
	return null;
}

export function FlagList({ flags }: { flags: Flag[] }) {
	// Settled here, shown at once, until the reload brings it.
	const [settled, setSettled] = useState<Map<number, "applied" | "dismissed">>(
		new Map(),
	);
	const mark = (id: number, to: "applied" | "dismissed" | null) =>
		setSettled((m) => {
			const next = new Map(m);
			if (to) next.set(id, to);
			else next.delete(id);
			return next;
		});

	async function settle(f: Flag, apply: boolean) {
		const to = apply ? "applied" : "dismissed";
		mark(f.id, to);
		const r = await optimism.change({
			label: apply ? "Applying" : "Dismissing",
			patch: [],
			send: () => resolvePoFlag({ data: { id: f.id, apply } }),
		});
		if (!r) return mark(f.id, null);
		offerUndo(apply ? `${f.sku ?? "Flag"} applied` : "Dismissed", {
			tone: apply ? "success" : undefined,
			undo: async () => {
				mark(f.id, null);
				const back = await optimism.change({
					label: "Putting it back",
					patch: [],
					send: () => reopenPoFlag({ data: { id: f.id } }),
				});
				if (!back) mark(f.id, to);
				return back ? "Flag back" : null;
			},
		});
	}

	return (
		<ul className="divide-y">
			{flags.map((f) => {
				const state = settled.get(f.id) ?? f.resolution;
				const Icon = ICON[f.kind];
				return (
					<li
						key={f.id}
						className={cn(
							"flex items-center gap-2 px-3 py-2 text-sm transition-opacity",
							state && "opacity-50",
						)}
					>
						<Icon
							className={cn(
								"size-4 shrink-0",
								state === "applied" ? "text-success-text" : "text-warning-text",
							)}
						/>
						<div className="min-w-0 flex-1">
							<div className="flex flex-wrap items-baseline gap-x-2">
								{f.sku && <span className="font-medium">{f.sku}</span>}
								<Change flag={f} />
							</div>
							<p
								className={cn(
									"text-muted-foreground",
									f.kind === "note" && "text-foreground",
									state === "dismissed" && "line-through",
								)}
							>
								{f.note}
							</p>
						</div>
						{state ? (
							state === "applied" ? (
								<Check className="size-4 text-success-text" />
							) : (
								<X className="size-4 text-muted-foreground" />
							)
						) : (
							<span className="flex shrink-0 gap-0.5">
								{f.kind !== "note" && (
									<Tip content="Apply">
										<Button
											size="sm"
											variant="secondary"
											aria-label="Apply"
											onClick={() => settle(f, true)}
										>
											<Check />
										</Button>
									</Tip>
								)}
								<Tip content="Dismiss">
									<Button
										size="sm"
										variant="ghost"
										aria-label="Dismiss"
										onClick={() => settle(f, false)}
									>
										<X />
									</Button>
								</Tip>
							</span>
						)}
					</li>
				);
			})}
		</ul>
	);
}

// Flags under a header that folds them away; open while any wait.
export function FoldingFlags({
	flags,
	className,
}: {
	flags: Flag[];
	// The header's tint and padding, as where it sits needs.
	className?: string;
}) {
	const waiting = flags.filter((f) => f.resolution === null).length;
	const [open, setOpen] = useState(waiting > 0);
	return (
		<>
			<button
				type="button"
				onClick={() => setOpen((o) => !o)}
				aria-expanded={open}
				className={cn(
					"flex w-full items-center gap-2 text-left text-sm font-semibold",
					className,
				)}
			>
				<ChevronRight
					className={cn(
						"size-4 shrink-0 transition-transform",
						open && "rotate-90",
					)}
				/>
				<span className="flex-1">Flags</span>
				<span className="font-medium tabular-nums">
					{waiting > 0 ? waiting : flags.length}
				</span>
			</button>
			{open && (
				<div className="border-t animate-in fade-in-0 slide-in-from-top-1">
					<FlagList flags={flags} />
				</div>
			)}
		</>
	);
}

// The PO page's flags, above its lines while any wait.
export function FlagsCard({ flags }: { flags: Flag[] }) {
	if (flags.length === 0) return null;
	return (
		<Card flush>
			<FoldingFlags
				flags={flags}
				className="bg-warning-surface px-4 py-4 text-warning-text"
			/>
		</Card>
	);
}

// Flags a suggestion would raise, before anyone takes it.
export function ProposedFlags({ flags }: { flags: FlagInput[] }) {
	return (
		<>
			{flags.map((f) => {
				const Icon = ICON[f.kind];
				return (
					<Tip key={`${f.kind}${f.sku}${f.note}`} content={f.note}>
						<span className="inline-flex items-center gap-1 rounded-md bg-warning-surface px-1.5 py-0.5 text-xs text-warning-text tabular-nums [&_svg]:size-3">
							<Icon />
							{f.sku ?? f.note}
							{"value" in f &&
								` ${f.kind === "price" ? money(f.value) : f.value}`}
						</span>
					</Tip>
				);
			})}
		</>
	);
}
