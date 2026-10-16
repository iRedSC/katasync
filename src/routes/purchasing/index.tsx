import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { ClipboardList, Plus } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { Badge, Card, EmptyState, Page } from "#/components/page";
import { Button } from "#/components/ui/button";
import {
	Command,
	CommandEmpty,
	CommandGroup,
	CommandInput,
	CommandItem,
	CommandList,
} from "#/components/ui/command";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogTitle,
} from "#/components/ui/dialog";
import { formatCount, formatDay, formatMoney } from "#/lib/format";
import { useHotkeys } from "#/lib/hotkeys";
import { cn } from "#/lib/utils";
import { purchaseOrderStatus } from "#/purchasing/status";
import {
	createDraft,
	listPurchasing,
	openSuggestedPurchaseOrder,
	type PurchasingList,
} from "#/server/purchasing";

export const Route = createFileRoute("/purchasing/")({
	loader: () => listPurchasing(),
	component: Purchasing,
});

function Purchasing() {
	const { ready, open, incoming, done, suppliers } = Route.useLoaderData();
	const nothing =
		ready.length === 0 &&
		open.length === 0 &&
		incoming.length === 0 &&
		done.length === 0;

	return (
		<Page
			title="Purchase orders"
			actions={
				<>
					<Button asChild variant="outline" size="sm">
						<Link to="/purchasing/suppliers">Suppliers</Link>
					</Button>
					<NewPurchaseOrder suppliers={suppliers} />
				</>
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
					{incoming.length > 0 && (
						<Card title="Incoming" flush>
							<OrderTable rows={incoming} />
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

// Starts a blank draft for any supplier; "Add what needs reordering" on the
// draft fills it in. A supplier with a draft already opens that one. Picked
// like the Find palette: type a few letters, Enter.
function NewPurchaseOrder({
	suppliers,
}: {
	suppliers: PurchasingList["suppliers"];
}) {
	const navigate = useNavigate();
	const [open, setOpen] = useState(false);
	const [busy, setBusy] = useState(false);

	useHotkeys({ n: () => setOpen(true) });

	async function create(supplierId: number) {
		setBusy(true);
		try {
			const id = await createDraft({
				data: { supplierId },
			});
			setOpen(false);
			navigate({ to: "/purchasing/$id", params: { id: String(id) } });
		} catch (err) {
			toast.error(err instanceof Error ? err.message : String(err));
		} finally {
			setBusy(false);
		}
	}

	return (
		<>
			<Button size="sm" onClick={() => setOpen(true)}>
				<Plus />
				New PO
				<kbd className="text-xs opacity-60">N</kbd>
			</Button>
			<Dialog open={open} onOpenChange={setOpen}>
				<DialogContent
					className="overflow-hidden p-0 sm:max-w-2xl"
					showCloseButton={false}
				>
					<DialogTitle className="sr-only">New PO</DialogTitle>
					<DialogDescription className="sr-only">
						Pick the supplier this PO is for.
					</DialogDescription>
					<Command>
						<CommandInput placeholder="New PO for which supplier?" />
						<CommandList>
							<CommandEmpty>No supplier by that name.</CommandEmpty>
							<CommandGroup heading="Suppliers">
								{suppliers.map((s) => (
									<CommandItem
										key={s.id}
										value={s.name}
										disabled={busy}
										onSelect={() => create(s.id)}
									>
										{s.name}
									</CommandItem>
								))}
							</CommandGroup>
						</CommandList>
					</Command>
				</DialogContent>
			</Dialog>
		</>
	);
}

type Suggestion = PurchasingList["ready"][number];

// One row per supplier: what today's sales say to send them. Clicking a row
// opens it on the PO page; it only becomes a draft once it's changed.
function SuggestionList({ rows }: { rows: Suggestion[] }) {
	const navigate = useNavigate();
	const [busy, setBusy] = useState<number | null>(null);

	async function open(s: Suggestion) {
		setBusy(s.supplierId);
		try {
			const id = await openSuggestedPurchaseOrder({
				data: { supplierId: s.supplierId },
			});
			navigate({ to: "/purchasing/$id", params: { id: String(id) } });
		} catch (err) {
			toast.error(err instanceof Error ? err.message : String(err));
		} finally {
			setBusy(null);
		}
	}

	// Same columns as the PO tables below, so the page reads as one list.
	return (
		<table className="w-full table-fixed">
			<Columns />
			<thead>
				<tr className="border-y bg-subtle text-left text-xs text-muted-foreground">
					<th className="px-4 py-2 font-medium">PO</th>
					<th className="px-4 py-2 font-medium">Supplier</th>
					<th className="px-4 py-2 font-medium">Status</th>
					<th className="hidden px-4 py-2 font-medium md:table-cell">
						Products
					</th>
					<th className="px-4 py-2 text-right font-medium">Total</th>
					<th className="hidden px-4 py-2 font-medium md:table-cell">
						Expected
					</th>
				</tr>
			</thead>
			<tbody>
				{rows.map((s) => (
					<tr
						key={s.supplierId}
						onClick={() => busy === null && open(s)}
						className={cn(
							"cursor-pointer border-t first:border-t-0 hover:bg-subtle",
							busy !== null && "cursor-wait",
						)}
					>
						<td className="px-4 py-2.5 font-semibold whitespace-nowrap">
							<span className="font-normal text-muted-foreground">New</span>
						</td>
						<td className="px-4 py-2.5">
							<div className="truncate">{s.supplierName}</div>
						</td>
						<td className="px-4 py-2.5 whitespace-nowrap">
							{busy === s.supplierId ? (
								<span className="text-muted-foreground">Opening…</span>
							) : s.readiness === "critical" ? (
								<Badge tone="critical">Stockout risk</Badge>
							) : (
								<Badge tone="success">Ready</Badge>
							)}
						</td>
						<td className="hidden px-4 py-2.5 whitespace-nowrap text-muted-foreground md:table-cell">
							<div className="truncate">
								{formatCount(s.lines.length)}{" "}
								{s.lines.length === 1 ? "product" : "products"}
								{s.unpriced > 0 && `, ${s.unpriced} unpriced`}
							</div>
						</td>
						<td className="px-4 py-2.5 text-right tabular-nums">
							{formatMoney(s.total)}
						</td>
						<td className="hidden px-4 py-2.5 text-muted-foreground md:table-cell">
							—
						</td>
					</tr>
				))}
			</tbody>
		</table>
	);
}

type OrderRow = PurchasingList["open"][number];

// Every table on this page shares these widths, so their columns line up
// down the page whatever the contents. Supplier takes what's left.
function Columns() {
	return (
		<colgroup>
			<col className="w-24" />
			<col />
			<col className="w-40" />
			<col className="hidden w-52 md:table-column" />
			<col className="w-28" />
			<col className="hidden w-32 md:table-column" />
		</colgroup>
	);
}

function OrderTable({ rows }: { rows: OrderRow[] }) {
	const navigate = useNavigate();
	return (
		<table className="w-full table-fixed">
			<Columns />
			<thead>
				<tr className="border-y bg-subtle text-left text-xs text-muted-foreground">
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
							className="cursor-pointer border-t first:border-t-0 hover:bg-subtle"
						>
							<td className="px-4 py-2.5 font-semibold whitespace-nowrap">
								PO {o.id}
							</td>
							<td className="px-4 py-2.5">
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
