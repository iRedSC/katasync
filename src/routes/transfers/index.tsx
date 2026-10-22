import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { Loader2, Shuffle } from "lucide-react";
import { useRef, useState } from "react";
import { toast } from "sonner";
import { Badge, Card, EmptyState, Page } from "#/components/page";
import { ListCard, ListSkeleton } from "#/components/skeleton";
import { Button } from "#/components/ui/button";
import { Tip } from "#/components/ui/tooltip";
import { formatCount, formatDay } from "#/lib/format";
import { optimism } from "#/lib/optimism";
import { useRowLink } from "#/lib/row-link";
import { listTransfers, newRefill, newTransfer } from "#/server/transfers";

export const Route = createFileRoute("/transfers/")({
	loader: () => listTransfers(),
	component: Transfers,
	pendingComponent: () => (
		<ListSkeleton title="Transfers">
			<ListCard title="Drafts" rows={2} />
		</ListSkeleton>
	),
});

type Loaded = Awaited<ReturnType<typeof listTransfers>>;
type Row = Loaded["drafts"][number];

// Stock moving between our locations: drafts being put together, and what
// was sent. A refill fills a draft with what tops Retail up to its targets.
function Transfers() {
	const { drafts, sent, places, refill } = Route.useLoaderData();
	const navigate = useNavigate();
	const open = (id: number) =>
		navigate({ to: "/transfers/$id", params: { id: String(id) } });
	const [from, to] = places;

	// Both create buttons share this: while one draft is being made, neither
	// makes another. The ref is set at once, so a second click that lands before
	// the state re-renders still counts.
	const [making, setMaking] = useState<"refill" | "blank" | null>(null);
	const busy = useRef(false);
	async function create(kind: "refill" | "blank", make: () => Promise<void>) {
		if (busy.current) return;
		busy.current = true;
		setMaking(kind);
		try {
			await make();
		} finally {
			busy.current = false;
			setMaking(null);
		}
	}

	async function startRefill() {
		await create("refill", async () => {
			const r = await optimism.change({ send: () => newRefill() });
			if (!r) return;
			if (r.value.none.length > 0)
				toast.warning(
					`The warehouse has none of ${formatCount(r.value.none.length)} ${r.value.none.length === 1 ? "product" : "products"} Retail needs`,
					{ description: r.value.none.join(", ") },
				);
			open(r.value.id);
		});
	}

	async function startBlank() {
		if (!from || !to) return;
		await create("blank", async () => {
			const r = await optimism.change({
				send: () =>
					newTransfer({
						data: { fromLocationId: from.id, toLocationId: to.id },
					}),
			});
			if (r) open(r.value.id);
		});
	}

	const refillButton = (
		<Button
			onClick={startRefill}
			disabled={refill.ready === 0 || making !== null}
		>
			{making === "refill" && <Loader2 className="animate-spin" />}
			Refill{refill.ready > 0 && ` ${formatCount(refill.ready)}`}
		</Button>
	);
	return (
		<Page
			title="Transfers"
			actions={
				<>
					{refill.possible &&
						(refill.ready === 0 ? (
							<Tip
								content={
									refill.none > 0
										? `Retail is below target on ${formatCount(refill.none)}, but the warehouse has none`
										: "Retail is at its targets. Set targets on the Retail row of a product's inventory."
								}
							>
								<span>{refillButton}</span>
							</Tip>
						) : (
							refillButton
						))}
					{places.length < 2 ? (
						<Tip content="Transfers need two of our locations">
							<span>
								<Button variant="outline" disabled>
									New transfer
								</Button>
							</span>
						</Tip>
					) : (
						<Button
							variant="outline"
							onClick={startBlank}
							disabled={making !== null}
						>
							{making === "blank" && <Loader2 className="animate-spin" />}
							New transfer
						</Button>
					)}
				</>
			}
		>
			{drafts.length === 0 && sent.length === 0 ? (
				<Card>
					<EmptyState icon={Shuffle} title="No transfers yet">
						Put together a list of stock to move, then send it all at once.
						Refill fills one with what Retail is short of.
					</EmptyState>
				</Card>
			) : (
				<>
					{drafts.length > 0 && <TransferTable title="Drafts" rows={drafts} />}
					{sent.length > 0 && <TransferTable title="Sent" rows={sent} />}
				</>
			)}
		</Page>
	);
}

function TransferTable({ title, rows }: { title: string; rows: Row[] }) {
	const { link } = useRowLink();
	return (
		<Card title={title} flush>
			<table className="w-full">
				<thead>
					<tr className="border-y bg-subtle text-left text-xs text-muted-foreground">
						<th className="px-4 py-2 font-medium">Transfer</th>
						<th className="px-4 py-2 font-medium">Route</th>
						<th className="px-4 py-2 text-right font-medium">Products</th>
						<th className="px-4 py-2 text-right font-medium">Units</th>
						<th className="px-4 py-2 font-medium">Note</th>
						<th className="px-4 py-2 text-right font-medium">
							{title === "Sent" ? "Sent" : "Started"}
						</th>
					</tr>
				</thead>
				<tbody>
					{rows.map((t) => (
						<tr
							key={t.id}
							{...link({ to: "/transfers/$id", params: { id: String(t.id) } })}
							className="cursor-pointer border-t hover:bg-subtle"
						>
							<td className="px-4 py-2.5 font-medium">T{t.id}</td>
							<td className="px-4 py-2.5">
								{t.from} → {t.to}
							</td>
							<td className="px-4 py-2.5 text-right tabular-nums">
								{t.lines === 0 ? <Badge>Empty</Badge> : formatCount(t.lines)}
							</td>
							<td className="px-4 py-2.5 text-right tabular-nums">
								{formatCount(t.units)}
							</td>
							<td className="max-w-64 truncate px-4 py-2.5 text-muted-foreground">
								{t.note}
							</td>
							<td className="px-4 py-2.5 text-right text-muted-foreground">
								{formatDay(t.sentAt ?? t.createdAt)}
							</td>
						</tr>
					))}
				</tbody>
			</table>
		</Card>
	);
}
