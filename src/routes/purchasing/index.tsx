import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import {
	Ban,
	ClipboardList,
	ExternalLink,
	FileText,
	Mail,
	PackageCheck,
	Plus,
	RefreshCw,
	Repeat,
	Trash2,
} from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { Badge, Card, EmptyState, Page } from "#/components/page";
import { cancelWithUndo } from "#/components/po-cancel";
import { ListCard, ListSkeleton } from "#/components/skeleton";
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
	ContextMenu,
	ContextMenuContent,
	ContextMenuItem,
	ContextMenuSeparator,
	ContextMenuTrigger,
} from "#/components/ui/context-menu";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogTitle,
} from "#/components/ui/dialog";
import { Tip } from "#/components/ui/tooltip";
import { formatCount, formatDay, formatMoney } from "#/lib/format";
import { useHotkeys } from "#/lib/hotkeys";
import { optimism } from "#/lib/optimism";
import { useRowLink } from "#/lib/row-link";
import { cn } from "#/lib/utils";
import {
	cancelledRow,
	purchasingData,
	withOrder,
	withoutOrder,
} from "#/purchasing/list-patches";
import {
	isLate,
	purchaseOrderStatus,
	suggestionStatus,
} from "#/purchasing/status";
import {
	createDraft,
	createDraftFromSuggestions,
	listPurchasing,
	orderPurchaseOrderAgain,
	type PurchasingList,
	updateDraftFromSuggestions,
} from "#/server/purchasing";

export const Route = createFileRoute("/purchasing/")({
	loader: () => listPurchasing(),
	component: Purchasing,
	pendingComponent: () => (
		<ListSkeleton title="Purchase orders">
			<ListCard title="Ready to order" rows={3} />
			<ListCard title="Open" rows={4} />
		</ListSkeleton>
	),
});

// An unpatched change waits for the page to reload, so a toast says what's
// under way until then. A menu closes as it's used, so nothing else would.
async function whileWorking<T>(message: string, work: Promise<T>): Promise<T> {
	const id = toast.loading(message);
	try {
		return await work;
	} finally {
		toast.dismiss(id);
	}
}

function Purchasing() {
	const loaded = Route.useLoaderData();
	const { ready, open, incoming, done, suppliers, emailsToFile } =
		purchasingData.useData("all", loaded);
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
					<Button asChild variant="outline" size="sm">
						<Link to="/inbox" search={{ folder: "to-file" }}>
							<Mail />
							Emails
							{emailsToFile > 0 && (
								<span className="rounded-md bg-surface-strong px-1.5 text-xs tabular-nums">
									{emailsToFile}
								</span>
							)}
						</Link>
					</Button>
					<NewPurchaseOrder suppliers={suppliers} />
				</>
			}
		>
			{nothing ? (
				<Card>
					<EmptyState icon={ClipboardList} title="Nothing to reorder">
						Products without a supplier aren't suggested.
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
		const r = await optimism.change({
			send: () => createDraft({ data: { supplierId } }),
		});
		setBusy(false);
		if (!r) return;
		setOpen(false);
		navigate({ to: "/purchasing/$id", params: { id: String(r.value) } });
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
						Pick a supplier
					</DialogDescription>
					<Command>
						<CommandInput placeholder="Supplier" />
						<CommandList>
							<CommandEmpty>No matches</CommandEmpty>
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
// opens it on the PO page at once, where it only becomes a draft once it's
// changed. "Create PO" makes the draft straight away.
function SuggestionList({ rows }: { rows: Suggestion[] }) {
	const [menuFor, setMenuFor] = useState<Suggestion | null>(null);
	const { creating, create } = useCreateDraft();
	const { link } = useRowLink();
	const navigate = useNavigate();
	const to = (s: Suggestion) =>
		({
			to: "/purchasing/suggested/$supplierId",
			params: { supplierId: String(s.supplierId) },
		}) as const;

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
					<th className="hidden px-4 py-2 font-medium md:table-cell">
						Arrived
					</th>
					<th className="px-4 py-2 text-right font-medium">Total</th>
					<th className="hidden px-4 py-2 font-medium md:table-cell">
						Expected
					</th>
				</tr>
			</thead>
			<ContextMenu>
				<ContextMenuTrigger asChild>
					<tbody>
						{rows.map((s) => (
							<tr
								key={s.supplierId}
								{...link(to(s))}
								onContextMenu={() => setMenuFor(s)}
								className="cursor-pointer border-t first:border-t-0 hover:bg-subtle"
							>
								<td className="px-4 py-2.5 font-semibold whitespace-nowrap">
									<span className="font-normal text-muted-foreground">New</span>
								</td>
								<td className="px-4 py-2.5">
									<div className="truncate">{s.supplierName}</div>
								</td>
								<td className="px-4 py-2.5 whitespace-nowrap">
									{creating === s.supplierId ? (
										<span className="text-muted-foreground">Creating…</span>
									) : (
										<ReadinessBadge s={s} />
									)}
								</td>
								<td className="hidden px-4 py-2.5 whitespace-nowrap text-muted-foreground md:table-cell">
									<div className="truncate">
										<ProductCount s={s} />
									</div>
								</td>
								<td className="hidden md:table-cell" />
								<td className="px-4 py-2.5 text-right tabular-nums">
									{formatMoney(s.total)}
								</td>
								<td className="hidden px-4 py-2.5 text-muted-foreground md:table-cell">
									No date
								</td>
							</tr>
						))}
					</tbody>
				</ContextMenuTrigger>
				{menuFor && (
					<ContextMenuContent>
						<ContextMenuItem
							shortcut="↵"
							onSelect={() => navigate(to(menuFor))}
						>
							<FileText />
							Open
						</ContextMenuItem>
						<ContextMenuItem
							disabled={creating !== null}
							onSelect={() => create(menuFor.supplierId)}
						>
							<Plus />
							Create PO
						</ContextMenuItem>
					</ContextMenuContent>
				)}
			</ContextMenu>
		</table>
	);
}

function ReadinessBadge({ s }: { s: Suggestion }) {
	const status = suggestionStatus(s.readiness);
	return <Badge tone={status.tone}>{status.label}</Badge>;
}

function ProductCount({ s }: { s: Suggestion }) {
	return (
		<>
			{formatCount(s.lines.length)}{" "}
			{s.lines.length === 1 ? "product" : "products"}
			{s.unpriced > 0 && `, ${s.unpriced} unpriced`}
		</>
	);
}

// Makes the supplier's draft from today's suggestions and opens it. The new
// PO's number comes from the server, so the row shows Creating… until it's in.
function useCreateDraft() {
	const navigate = useNavigate();
	const [creating, setCreating] = useState<number | null>(null);

	async function create(supplierId: number) {
		setCreating(supplierId);
		const r = await optimism.change({
			send: () => createDraftFromSuggestions({ data: { supplierId } }),
		});
		setCreating(null);
		if (!r) return;
		toast.success(`PO ${r.value} created`);
		navigate({ to: "/purchasing/$id", params: { id: String(r.value) } });
	}
	return { creating, create };
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
			<col className="hidden w-28 md:table-column" />
			<col className="w-28" />
			<col className="hidden w-32 md:table-column" />
		</colgroup>
	);
}

function OrderTable({ rows }: { rows: OrderRow[] }) {
	const { link } = useRowLink();
	const [menuFor, setMenuFor] = useState<OrderRow | null>(null);
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
					<th className="hidden px-4 py-2 font-medium md:table-cell">
						Arrived
					</th>
					<th className="px-4 py-2 text-right font-medium">Total</th>
					<th className="hidden px-4 py-2 font-medium md:table-cell">
						Expected
					</th>
				</tr>
			</thead>
			{/* One menu for the whole table: it acts on the row that was
			    right-clicked. */}
			<ContextMenu>
				<ContextMenuTrigger asChild>
					<tbody>
						{rows.map((o) => {
							const status = purchaseOrderStatus(o);
							return (
								<tr
									key={o.id}
									{...link({
										to: "/purchasing/$id",
										params: { id: String(o.id) },
									})}
									onContextMenu={() => setMenuFor(o)}
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
									<td className="hidden px-4 py-2.5 whitespace-nowrap tabular-nums md:table-cell">
										<Arrived order={o} />
									</td>
									<td className="px-4 py-2.5 text-right tabular-nums">
										{formatMoney(o.total)}
									</td>
									<td
										className={cn(
											"hidden px-4 py-2.5 whitespace-nowrap md:table-cell",
											isLate(o)
												? "font-medium text-critical-text"
												: "text-muted-foreground",
										)}
									>
										{o.status === "sent" && o.expectedAt
											? formatDay(o.expectedAt)
											: o.closedAt
												? `Done ${formatDay(o.closedAt)}`
												: "No date"}
									</td>
								</tr>
							);
						})}
					</tbody>
				</ContextMenuTrigger>
				{menuFor && <OrderMenu order={menuFor} />}
			</ContextMenu>
		</table>
	);
}

// Tracked packages the carrier has delivered. Only evidence: what was
// actually counted in is Received.
function Arrived({ order: o }: { order: OrderRow }) {
	const { arrived, total, trouble } = o.packages;
	if (total === 0)
		return o.status === "sent" ? (
			<span className="text-muted-foreground">None</span>
		) : null;
	// Tip needs an element that takes a ref, so the badge sits in a span.
	const count = (
		<span className="inline-flex">
			<Badge
				tone={trouble ? "critical" : arrived === total ? "success" : "info"}
			>
				{formatCount(arrived)} of {formatCount(total)}
			</Badge>
		</span>
	);
	return trouble ? <Tip content="Carrier problem">{count}</Tip> : count;
}

// What each kind of PO can do from here. Sending and closing short aren't
// offered: both want the PO open, to check its lines or what arrived.
function OrderMenu({ order: o }: { order: OrderRow }) {
	const navigate = useNavigate();
	const name = `PO ${o.id}`;
	// Still a draft or on order; null once it's done.
	const live = o.status === "draft" || o.status === "sent" ? o.status : null;
	const done = live === null;

	// Brings a draft up to today's suggestions. What changed is only known from
	// the server, so the list waits for the reload.
	async function refresh() {
		const r = await whileWorking(
			`Updating ${name} from today's suggestions`,
			optimism.change({
				send: () => updateDraftFromSuggestions({ data: { id: o.id } }),
			}),
		);
		if (!r) return;
		const { added, raised } = r.value;
		toast.success(
			added + raised === 0
				? `${name} is up to date`
				: `${name}: ${[
						added > 0 && `${formatCount(added)} added`,
						raised > 0 && `${formatCount(raised)} raised`,
					]
						.filter(Boolean)
						.join(", ")}`,
		);
	}

	// The list moves the PO as it's cancelled, and back as Undo puts it.
	const cancel = (status: "draft" | "sent") =>
		cancelWithUndo({ ...o, status }, undefined, {
			change: purchasingData.patch("all", (d) =>
				status === "draft"
					? withoutOrder(d, o.id)
					: withOrder(d, cancelledRow(o)),
			),
			undo: purchasingData.patch("all", (d) => withOrder(d, o)),
		});

	// The new order's number is only known from the server, so this waits for
	// the reload before it opens.
	async function again() {
		const r = await whileWorking(
			`Ordering ${name} again`,
			optimism.change({
				send: () => orderPurchaseOrderAgain({ data: { id: o.id } }),
			}),
		);
		if (!r) return;
		const { id, added, alreadyOn, moved, archived } = r.value;
		const left = [
			alreadyOn > 0 && `${formatCount(alreadyOn)} already on it`,
			moved > 0 && `${formatCount(moved)} now bought from another supplier`,
			archived > 0 && `${formatCount(archived)} archived`,
		].filter(Boolean);
		toast.success(
			`Added ${formatCount(added)} ${added === 1 ? "product" : "products"} from ${name} to PO ${id}`,
			left.length > 0
				? { description: `Left off: ${left.join(", ")}` }
				: undefined,
		);
		navigate({ to: "/purchasing/$id", params: { id: String(id) } });
	}

	return (
		<ContextMenuContent>
			<ContextMenuItem
				onSelect={() =>
					navigate({ to: "/purchasing/$id", params: { id: String(o.id) } })
				}
			>
				<FileText />
				Open
			</ContextMenuItem>
			<ContextMenuItem
				onSelect={() => window.open(`/purchasing/${o.id}`, "_blank")}
			>
				<ExternalLink />
				Open in new tab
			</ContextMenuItem>
			<ContextMenuSeparator />
			{o.status === "draft" && (
				<ContextMenuItem onSelect={refresh}>
					<RefreshCw />
					Update from today's suggestions
				</ContextMenuItem>
			)}
			{o.status === "sent" && (
				<ContextMenuItem
					onSelect={() =>
						navigate({ to: "/receive/$id", params: { id: String(o.id) } })
					}
				>
					<PackageCheck />
					Receive
				</ContextMenuItem>
			)}
			{done && (
				<ContextMenuItem onSelect={again}>
					<Repeat />
					Order again
				</ContextMenuItem>
			)}
			{o.lines > 0 && (
				<ContextMenuItem
					onSelect={() => window.open(`/purchasing/pdf/${o.id}`, "_blank")}
				>
					<FileText />
					View PDF
				</ContextMenuItem>
			)}
			{!done && o.supplierEmail && (
				<ContextMenuItem
					onSelect={() => {
						window.location.href = `mailto:${o.supplierEmail}?subject=${encodeURIComponent(`Purchase order ${o.id}`)}`;
					}}
				>
					<Mail />
					Email {o.supplierName}
				</ContextMenuItem>
			)}
			{live && o.received === 0 && (
				<>
					<ContextMenuSeparator />
					<ContextMenuItem
						onSelect={() => cancel(live)}
						className="text-critical-text [&_svg]:text-critical-text"
					>
						{live === "draft" ? <Trash2 /> : <Ban />}
						{live === "draft" ? "Delete draft" : "Cancel PO"}
					</ContextMenuItem>
				</>
			)}
		</ContextMenuContent>
	);
}
