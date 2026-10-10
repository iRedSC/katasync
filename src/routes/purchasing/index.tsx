import {
	createFileRoute,
	Link,
	useNavigate,
	useRouter,
} from "@tanstack/react-router";
import { ClipboardList, Plus } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { Badge, Card, EmptyState, Page } from "#/components/page";
import { Button } from "#/components/ui/button";
import { formatCount, formatDay, formatMoney } from "#/lib/format";
import { cn } from "#/lib/utils";
import { purchaseOrderStatus } from "#/purchasing/status";
import {
	createDraft,
	listPurchasing,
	type PurchasingList,
} from "#/server/purchasing";

export const Route = createFileRoute("/purchasing/")({
	loader: () => listPurchasing(),
	component: Purchasing,
});

function Purchasing() {
	const { suggestions, open, done } = Route.useLoaderData();
	const ready = suggestions.filter((s) => s.ready);
	const waiting = suggestions.filter((s) => !s.ready);
	const nothing =
		suggestions.length === 0 && open.length === 0 && done.length === 0;

	return (
		<Page
			title="Purchase orders"
			actions={
				<Button asChild variant="outline" size="sm">
					<Link to="/purchasing/suppliers">Suppliers</Link>
				</Button>
			}
		>
			{nothing ? (
				<Card>
					<EmptyState icon={ClipboardList} title="Nothing to reorder">
						Stock covers every product's sales until a new order would arrive.
						Products need a supplier before they're suggested.
					</EmptyState>
				</Card>
			) : (
				<>
					{ready.length > 0 && (
						<Card title="Ready to order" flush>
							<SuggestionList rows={ready} />
						</Card>
					)}
					{open.length > 0 && (
						<Card title="Open" flush>
							<OrderTable rows={open} />
						</Card>
					)}
					{waiting.length > 0 && (
						<Card
							title="Below the supplier's minimum"
							aside="Order these with the next PO, or wait until they add up"
							flush
						>
							<SuggestionList rows={waiting} />
						</Card>
					)}
					{done.length > 0 && (
						<Card title="Done" flush>
							<OrderTable rows={done} />
						</Card>
					)}
				</>
			)}
		</Page>
	);
}

type Suggestion = PurchasingList["suggestions"][number];

// One row per supplier: what today's sales say to send them.
function SuggestionList({ rows }: { rows: Suggestion[] }) {
	const navigate = useNavigate();
	const router = useRouter();
	const [busy, setBusy] = useState<number | null>(null);

	async function open(s: Suggestion) {
		setBusy(s.supplierId);
		try {
			const id = await createDraft({ data: { supplierId: s.supplierId } });
			router.invalidate();
			navigate({ to: "/purchasing/$id", params: { id: String(id) } });
		} catch (err) {
			toast.error(err instanceof Error ? err.message : String(err));
		} finally {
			setBusy(null);
		}
	}

	return (
		<ul>
			{rows.map((s) => {
				const short = s.minimumOrder - s.total;
				// The products the PO is mostly for, so the row says something.
				const top = [...s.lines]
					.sort((a, b) => b.sold - a.sold)
					.slice(0, 3)
					.map((l) => l.name);
				return (
					<li
						key={s.supplierId}
						className="flex items-center gap-4 border-t px-4 py-3 first:border-t-0"
					>
						<div className="min-w-0 flex-1">
							<div className="flex items-center gap-2">
								<span className="font-semibold">{s.supplierName}</span>
								{s.draftId && <Badge tone="info">Draft open</Badge>}
							</div>
							<div className="truncate text-muted-foreground">
								{formatCount(s.lines.length)}{" "}
								{s.lines.length === 1 ? "product" : "products"}:{" "}
								{top.join(", ")}
								{s.lines.length > 3 && ", …"}
							</div>
						</div>
						<div className="text-right">
							<div className="font-semibold tabular-nums">
								{formatMoney(s.total)}
							</div>
							<div className="text-xs whitespace-nowrap text-muted-foreground">
								{s.ready
									? s.unpriced > 0 && `+ ${s.unpriced} without a price`
									: `${formatMoney(short)} short of ${formatMoney(s.minimumOrder)}`}
							</div>
						</div>
						<Button
							size="sm"
							variant={s.ready ? "default" : "outline"}
							disabled={busy !== null}
							onClick={() => open(s)}
							className="w-28"
						>
							{busy === s.supplierId ? (
								"Opening…"
							) : s.draftId ? (
								"Open draft"
							) : (
								<>
									<Plus />
									Create PO
								</>
							)}
						</Button>
					</li>
				);
			})}
		</ul>
	);
}

type OrderRow = PurchasingList["open"][number];

function OrderTable({ rows }: { rows: OrderRow[] }) {
	const navigate = useNavigate();
	return (
		<table className="w-full">
			<thead>
				<tr className="border-y bg-[#f7f7f7] text-left text-xs text-muted-foreground">
					<th className="px-4 py-2 font-medium">PO</th>
					<th className="px-4 py-2 font-medium">Supplier</th>
					<th className="px-4 py-2 font-medium">Status</th>
					<th className="hidden px-4 py-2 font-medium md:table-cell">
						Received
					</th>
					<th className="px-4 py-2 text-right font-medium">Total</th>
					<th className="hidden px-4 py-2 font-medium md:table-cell">
						Expected
					</th>
				</tr>
			</thead>
			<tbody>
				{rows.map((o) => {
					const status = purchaseOrderStatus(o);
					return (
						<tr
							key={o.id}
							onClick={() =>
								navigate({
									to: "/purchasing/$id",
									params: { id: String(o.id) },
								})
							}
							className="cursor-pointer border-t first:border-t-0 hover:bg-[#f7f7f7]"
						>
							<td className="px-4 py-2.5 font-semibold whitespace-nowrap">
								PO {o.id}
							</td>
							<td className="w-full max-w-0 px-4 py-2.5">
								<div className="truncate">{o.supplierName}</div>
							</td>
							<td className="px-4 py-2.5">
								<Badge tone={status.tone}>{status.label}</Badge>
							</td>
							<td className="hidden px-4 py-2.5 whitespace-nowrap tabular-nums md:table-cell">
								{o.status === "draft" ? (
									<span className="text-muted-foreground">
										{formatCount(o.lines)}{" "}
										{o.lines === 1 ? "product" : "products"}
									</span>
								) : (
									<span
										className={cn(
											o.received < o.ordered && "text-muted-foreground",
										)}
									>
										{formatCount(o.received)} of {formatCount(o.ordered)}
									</span>
								)}
							</td>
							<td className="px-4 py-2.5 text-right tabular-nums">
								{formatMoney(o.total)}
							</td>
							<td className="hidden px-4 py-2.5 whitespace-nowrap text-muted-foreground md:table-cell">
								{o.status === "sent" && o.expectedAt
									? formatDay(o.expectedAt)
									: o.closedAt
										? `Done ${formatDay(o.closedAt)}`
										: "—"}
							</td>
						</tr>
					);
				})}
			</tbody>
		</table>
	);
}
