import { Link, useRouter } from "@tanstack/react-router";
import { ExternalLink, Minus, Plus } from "lucide-react";
import { type FormEvent, type ReactNode, useState } from "react";
import { toast } from "sonner";
import { ProductImage } from "#/components/product";
import { type RefurbChoice, RefurbishForm } from "#/components/refurbish-form";
import { Button } from "#/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "#/components/ui/dialog";
import { formatCount } from "#/lib/format";
import { optimism, type Patch } from "#/lib/optimism";
import { offerUndo } from "#/lib/undo";
import { printPdf } from "#/printing/qz-client";
import { startBenchJob } from "#/server/bench";
import {
	getRefurbishOptions,
	receiveOrderReturn,
	refurbishOrderReturn,
	undoOrderReturn,
} from "#/server/orders";
import { moveRepairTo } from "#/server/repairs";

type ReturnLine = {
	id: number;
	title: string;
	sku: string | null;
	imageUrl: string | null;
	// What can still come back: sold minus already returned.
	left: number;
	// What the counts start at, when not everything left is expected.
	start?: number;
};

export type Received = { lineId: number; quantity: number };

// Where the units went: their shelf, a refurb's, or nowhere.
export type Outcome = "restock" | "refurbish" | "write_off";

// What came back in the box, line by line. Starts at everything still
// returnable (or what's expected), since most returns are the whole order; Enter puts it all
// back on the shelf. Refurbish (one line at a time) turns to choosing the
// refurb; Repair puts them on the repair board to fix first, a bench job
// and a ticket each, and lists them from there (src/repairs/bench.ts). The
// note goes with it to whoever decides the refund. It closes at once: the
// page shows the return before the server has it, and a failure says why
// in a toast.
export function ReturnDialog({
	open,
	onOpenChange,
	orderId,
	orderName,
	lines,
	patches,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	orderId: number;
	orderName: string;
	lines: ReturnLine[];
	// The page's data with a return laid over it, and with it taken off again
	// for Undo.
	patches: {
		receive: (received: Received[], outcome: Outcome) => Patch;
		undo: (received: Received[], outcome: Outcome) => Patch;
	};
}) {
	const [refurbishing, setRefurbishing] = useState(false);
	const [note, setNote] = useState("");
	const said = note.trim() || undefined;
	const router = useRouter();
	const [counts, setCounts] = useState(
		() =>
			new Map(lines.map((l) => [l.id, Math.min(l.start ?? l.left, l.left)])),
	);
	const total = [...counts.values()].reduce((sum, n) => sum + n, 0);

	const set = (line: ReturnLine, n: number) =>
		setCounts(
			new Map(counts).set(line.id, Math.max(0, Math.min(line.left, n))),
		);

	const received = [...counts]
		.filter(([, quantity]) => quantity > 0)
		.map(([lineId, quantity]) => ({ lineId, quantity }));
	// A refurb is one thing: one line's units.
	const single = received.length === 1 ? received[0] : null;
	const singleLine = single && lines.find((l) => l.id === single.lineId);

	function receive(restock: boolean) {
		onOpenChange(false);
		const outcome = restock ? "restock" : "write_off";
		const count = received.reduce((sum, l) => sum + l.quantity, 0);
		record(
			received,
			outcome,
			() =>
				receiveOrderReturn({
					data: { orderId, lines: received, outcome, note: said },
				}),
			() => ({
				message: restock
					? `${formatCount(count)} back on the shelf`
					: `${formatCount(count)} written off as damaged`,
			}),
		);
	}

	function refurbish(choice: RefurbChoice) {
		if (!single) return;
		onOpenChange(false);
		const n = formatCount(single.quantity);
		if (choice.kind === "add")
			record(
				[single],
				"refurbish",
				() =>
					receiveOrderReturn({
						data: {
							orderId,
							lines: [single],
							outcome: { refurbishInto: choice.productId },
							note: said,
						},
					}),
				() => ({ message: `${n} added to ${choice.sku}` }),
				printBoxLabel,
			);
		else {
			const { kind: _, ...details } = choice;
			record(
				[single],
				"refurbish",
				() =>
					refurbishOrderReturn({
						data: {
							...details,
							orderId,
							lineId: single.lineId,
							quantity: single.quantity,
							returnNote: said,
						},
					}),
				(r) => ({
					message: `${r.sku} drafted in Shopify`,
					description: r.shopifyUrl && (
						<a
							href={r.shopifyUrl}
							target="_blank"
							rel="noreferrer"
							className="inline-flex items-center gap-1 text-link underline"
						>
							Add photos and publish
							<ExternalLink className="size-3" />
						</a>
					),
				}),
				printBoxLabel,
			);
		}
	}

	async function bench() {
		if (!single) return;
		onOpenChange(false);
		const r = await optimism.change({
			send: () =>
				startBenchJob({
					data: {
						orderId,
						lineId: single.lineId,
						quantity: single.quantity,
						problem: said,
					},
				}),
		});
		if (!r) return;
		const { ids } = r.value;
		for (const id of ids)
			void printPdf(`/labels/repairs/${id}`, `R${id} ticket`);
		void router.invalidate();
		const names = ids.map((id) => `R${id}`).join(", ");
		offerUndo(`${names} on the bench`, {
			tone: "success",
			description: (
				<Link
					to="/repairs/$id"
					params={{ id: String(ids[0]) }}
					className="text-link underline"
				>
					Open {ids.length === 1 ? names : `R${ids[0]}`}
				</Link>
			),
			undo: async () => {
				const off = await optimism.change({
					send: () =>
						Promise.all(
							ids.map((id) => moveRepairTo({ data: { id, to: "cancelled" } })),
						),
				});
				void router.invalidate();
				return off && `${names} off the bench`;
			},
		});
	}

	// Every refurbished box gets its label, to find it by and ship it from.
	const printBoxLabel = (r: { ids: number[] }) =>
		r.ids[0] !== undefined &&
		void printPdf(`/labels/refurbs/${r.ids[0]}`, "Box label");

	async function record<R extends { ids: number[] }>(
		got: Received[],
		outcome: Outcome,
		send: () => Promise<R>,
		said: (r: R) => { message: string; description?: ReactNode },
		then?: (r: R) => void,
	) {
		const r = await optimism.change({
			label: `Return on ${orderName}`,
			patch: patches.receive(got, outcome),
			send,
		});
		if (!r) return;
		then?.(r.value);
		const { message, description } = said(r.value);
		offerUndo(message, {
			tone: "success",
			description: description ?? `Return on ${orderName}`,
			undo: async () => {
				const undone = await optimism.change({
					label: `Undoing return on ${orderName}`,
					patch: patches.undo(got, outcome),
					send: () => undoOrderReturn({ data: { ids: r.value.ids } }),
				});
				if (undone && undone.value.problems.length > 0)
					toast.error(undone.value.problems.join("; "));
				return undone && `Return on ${orderName} undone`;
			},
		});
	}

	function submit(e: FormEvent) {
		e.preventDefault();
		receive(true);
	}

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className={refurbishing ? "sm:max-w-xl" : "sm:max-w-lg"}>
				{refurbishing && single && singleLine ? (
					<RefurbishForm
						load={() =>
							getRefurbishOptions({
								data: { orderId, lineId: single.lineId },
							})
						}
						loadKey={`${orderId}:${single.lineId}`}
						quantity={single.quantity}
						name={singleLine.sku ?? singleLine.title}
						onBack={() => setRefurbishing(false)}
						onChoose={refurbish}
					/>
				) : (
					<form onSubmit={submit} className="flex min-w-0 flex-col gap-6">
						<DialogHeader>
							<DialogTitle>What came back?</DialogTitle>
							<DialogDescription>Return on {orderName}</DialogDescription>
						</DialogHeader>

						<ul className="flex flex-col gap-3">
							{lines.map((l) => {
								const n = counts.get(l.id) ?? 0;
								return (
									<li key={l.id} className="flex items-center gap-3">
										<ProductImage src={l.imageUrl} className="size-10" />
										<div className="min-w-0 flex-1">
											<div className="truncate font-medium">{l.title}</div>
											<div className="text-xs text-muted-foreground">
												{l.sku ?? "No SKU"}
											</div>
										</div>
										<div className="flex items-center gap-1">
											<Button
												type="button"
												size="icon"
												variant="outline"
												aria-label={`One fewer ${l.title}`}
												disabled={n === 0}
												onClick={() => set(l, n - 1)}
											>
												<Minus />
											</Button>
											<span className="w-16 text-center text-2xl font-semibold tabular-nums">
												{n}
												<span className="text-sm font-normal text-muted-foreground">
													{" "}
													/ {l.left}
												</span>
											</span>
											<Button
												type="button"
												size="icon"
												variant="outline"
												aria-label={`One more ${l.title}`}
												disabled={n === l.left}
												onClick={() => set(l, n + 1)}
											>
												<Plus />
											</Button>
										</div>
									</li>
								);
							})}
						</ul>

						<textarea
							value={note}
							onChange={(e) => setNote(e.target.value)}
							onKeyDown={(e) => {
								// Enter still puts it back on the shelf; Shift+Enter is a new line.
								if (e.key === "Enter" && !e.shiftKey) {
									e.preventDefault();
									e.currentTarget.form?.requestSubmit();
								}
							}}
							rows={2}
							maxLength={1000}
							placeholder="Note for refunds (optional): missing parts, wrong item, damage"
							className="w-full resize-none rounded-lg border border-input bg-white px-2 py-1.5 text-sm outline-none focus:border-ring"
						/>

						<DialogFooter className="flex-wrap gap-2 sm:justify-between">
							<div className="flex gap-2">
								<Button
									type="button"
									variant="outline"
									disabled={total === 0}
									onClick={() => receive(false)}
								>
									Damaged, write off
								</Button>
								<Button
									type="button"
									variant="outline"
									disabled={!single}
									onClick={() => setRefurbishing(true)}
								>
									Refurbish
								</Button>
								<Button
									type="button"
									variant="outline"
									disabled={!single}
									onClick={bench}
								>
									Repair
								</Button>
							</div>
							<Button type="submit" disabled={total === 0}>
								Put {formatCount(total)} back on shelf
							</Button>
						</DialogFooter>
					</form>
				)}
			</DialogContent>
		</Dialog>
	);
}
