import {
	createFileRoute,
	Link,
	useNavigate,
	useRouter,
} from "@tanstack/react-router";
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
import { formatCount, formatDay, formatMoney } from "#/lib/format";
import { useHotkeys } from "#/lib/hotkeys";
import { cn } from "#/lib/utils";
import { purchaseOrderStatus } from "#/purchasing/status";
import {
	createDraft,
	listPurchasing,
	orderPurchaseOrderAgain,
	type PurchasingList,
	updateDraftFromSuggestions,
} from "#/server/purchasing";

export const Route = createFileRoute("/purchasing/")({
	loader: () => listPurchasing(),
	component: Purchasing,
});

function Purchasing() {
	const { suggestions, open, done, suppliers } = Route.useLoaderData();
	const ready = suggestions.filter((s) => s.readiness !== "waiting");
	const nothing = ready.length === 0 && open.length === 0 && done.length === 0;

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
				data: { supplierId, fromSuggestions: false },
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

type Suggestion = PurchasingList["suggestions"][number];

// One row per supplier: what today's sales say to send them.
function SuggestionList({ rows }: { rows: Suggestion[] }) {
	const navigate = useNavigate();
	const router = useRouter();
	const [busy, setBusy] = useState<number | null>(null);
	const [menuFor, setMenuFor] = useState<Suggestion | null>(null);

	// `fromSuggestions: false` opens a draft with nothing on it yet.
	async function open(s: Suggestion, fromSuggestions = true) {
		setBusy(s.supplierId);
		try {
			const id = await createDraft({
				data: { supplierId: s.supplierId, fromSuggestions },
			});
			router.invalidate();
			navigate({ to: "/purchasing/$id", params: { id: String(id) } });
		} catch (err) {
			toast.error(err instanceof Error ? err.message : String(err));
		} finally {
			setBusy(null);
		}
	}

	// Same columns as the PO tables below, so the page reads as one list.
	// Clicking a row opens the supplier's draft, creating it if needed.
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
			<ContextMenu>
				<ContextMenuTrigger asChild>
					<tbody>
						{rows.map((s) => (
							<tr
								key={s.supplierId}
								onClick={() => busy === null && open(s)}
								onContextMenu={() => setMenuFor(s)}
								className={cn(
									"cursor-pointer border-t first:border-t-0 hover:bg-subtle",
									busy !== null && "cursor-wait",
								)}
							>
								<td className="px-4 py-2.5 font-semibold whitespace-nowrap">
									{s.draftId ? (
										`PO ${s.draftId}`
									) : (
										<span className="font-normal text-muted-foreground">
											New
										</span>
									)}
								</td>
								<td className="px-4 py-2.5">
									<div className="truncate">{s.supplierName}</div>
								</td>
								<td className="px-4 py-2.5 whitespace-nowrap">
									{busy === s.supplierId ? (
										<span className="text-muted-foreground">Opening…</span>
									) : s.readiness === "critical" ? (
										<Badge tone="critical">Critical</Badge>
									) : s.draftId ? (
										<Badge tone="info">Draft open</Badge>
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
				</ContextMenuTrigger>
				{menuFor && (
					<SuggestionMenu
						suggestion={menuFor}
						busy={busy !== null}
						onOpen={(fromSuggestions) => open(menuFor, fromSuggestions)}
					/>
				)}
			</ContextMenu>
		</table>
	);
}

// A supplier with a draft is a PO already, so it gets the draft's menu.
function SuggestionMenu({
	suggestion: s,
	busy,
	onOpen,
}: {
	suggestion: Suggestion;
	busy: boolean;
	onOpen: (fromSuggestions: boolean) => void;
}) {
	return (
		<ContextMenuContent>
			<ContextMenuItem disabled={busy} onSelect={() => onOpen(true)}>
				<FileText />
				{s.draftId ? `Open PO ${s.draftId}` : "Start a draft with these"}
			</ContextMenuItem>
			{s.draftId ? (
				<ContextMenuItem
					onSelect={() => window.open(`/purchasing/${s.draftId}`, "_blank")}
				>
					<ExternalLink />
					Open in new tab
				</ContextMenuItem>
			) : (
				<ContextMenuItem disabled={busy} onSelect={() => onOpen(false)}>
					<Plus />
					Start an empty draft
				</ContextMenuItem>
			)}
		</ContextMenuContent>
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
									onClick={() =>
										navigate({
											to: "/purchasing/$id",
											params: { id: String(o.id) },
										})
									}
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
				</ContextMenuTrigger>
				{menuFor && <OrderMenu order={menuFor} />}
			</ContextMenu>
		</table>
	);
}

// What each kind of PO can do from here. Sending and closing short aren't
// offered: both want the PO open, to check its lines or what arrived.
function OrderMenu({ order: o }: { order: OrderRow }) {
	const navigate = useNavigate();
	const router = useRouter();
	const name = `PO ${o.id}`;
	// Still a draft or on order; null once it's done.
	const live = o.status === "draft" || o.status === "sent" ? o.status : null;
	const done = live === null;

	async function attempt(work: () => Promise<void>) {
		try {
			await work();
		} catch (err) {
			toast.error(err instanceof Error ? err.message : String(err));
		}
	}

	const refresh = () =>
		attempt(async () => {
			const { added, raised } = await updateDraftFromSuggestions({
				data: { id: o.id },
			});
			await router.invalidate();
			toast.success(
				added + raised === 0
					? `${name} already has everything suggested`
					: `${name}: ${[
							added > 0 && `${formatCount(added)} added`,
							raised > 0 && `${formatCount(raised)} raised`,
						]
							.filter(Boolean)
							.join(", ")}`,
			);
		});

	const cancel = (status: "draft" | "sent") =>
		attempt(() => cancelWithUndo({ ...o, status }, () => router.invalidate()));

	const again = () =>
		attempt(async () => {
			const r = await orderPurchaseOrderAgain({ data: { id: o.id } });
			await router.invalidate();
			const left = [
				r.alreadyOn > 0 && `${formatCount(r.alreadyOn)} already on it`,
				r.moved > 0 &&
					`${formatCount(r.moved)} now bought from another supplier`,
			].filter(Boolean);
			toast.success(
				`Added ${formatCount(r.added)} ${r.added === 1 ? "product" : "products"} from ${name} to PO ${r.id}`,
				left.length > 0
					? { description: `Left off: ${left.join(", ")}` }
					: undefined,
			);
			navigate({ to: "/purchasing/$id", params: { id: String(r.id) } });
		});

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
