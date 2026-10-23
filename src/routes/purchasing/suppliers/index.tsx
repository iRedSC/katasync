import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { ArrowDown, ArrowUp, BookOpen, Search, X } from "lucide-react";
import { useRef } from "react";
import { CatalogMark } from "#/components/catalog-mark";
import { Badge, Card, Page } from "#/components/page";
import { ListSkeleton } from "#/components/skeleton";
import { Button } from "#/components/ui/button";
import { Tip } from "#/components/ui/tooltip";
import { formatCount, formatDay, formatMoney } from "#/lib/format";
import { useHotkeys } from "#/lib/hotkeys";
import { useRowLink } from "#/lib/row-link";
import { cn } from "#/lib/utils";
import { MIN_MEASURED_POS } from "#/purchasing/forecast";
import { listSupplierTable, type SupplierTableRow } from "#/server/purchasing";

// What each header sorts by, and which way a first click goes: names A to
// Z, numbers biggest first.
const SORTS = {
	name: { get: (r) => r.supplier.name.toLowerCase(), desc: false },
	catalogs: { get: (r) => r.catalogs.length, desc: true },
	products: { get: (r) => r.products, desc: true },
	open: { get: (r) => r.openOrders, desc: true },
	last: { get: (r) => r.lastSentAt?.getTime() ?? null, desc: true },
	spend: { get: (r) => r.spendYear, desc: true },
	lead: { get: (r) => r.leadTime.days, desc: false },
	threshold: { get: (r) => r.supplier.minimumOrder, desc: true },
} satisfies Record<
	string,
	{ get: (r: SupplierTableRow) => string | number | null; desc: boolean }
>;
type SortKey = keyof typeof SORTS;
const isSort = (k: unknown): k is SortKey =>
	typeof k === "string" && Object.hasOwn(SORTS, k);

type SupplierSearch = { q?: string; sort?: SortKey; desc?: boolean };

export const Route = createFileRoute("/purchasing/suppliers/")({
	validateSearch: (s: Record<string, unknown>): SupplierSearch => ({
		q: typeof s.q === "string" && s.q !== "" ? s.q : undefined,
		sort: isSort(s.sort) && s.sort !== "name" ? s.sort : undefined,
		desc: typeof s.desc === "boolean" ? s.desc : undefined,
	}),
	loader: () => listSupplierTable(),
	component: Suppliers,
	pendingComponent: () => (
		<ListSkeleton title="Suppliers" back={{ to: "/purchasing" }} />
	),
});

const DAY = 24 * 60 * 60 * 1000;

// "Today", "3 days ago", "5 weeks ago", then the date.
function ago(at: Date, now: Date) {
	const days = Math.floor((now.getTime() - at.getTime()) / DAY);
	if (days <= 0) return "Today";
	if (days === 1) return "Yesterday";
	if (days < 14) return `${days} days ago`;
	if (days < 60) return `${Math.floor(days / 7)} weeks ago`;
	if (days < 365) return `${Math.floor(days / 30)} months ago`;
	return formatDay(at);
}

// Everything a search can find a supplier by.
const haystack = (r: SupplierTableRow) =>
	[
		r.supplier.name,
		r.supplier.code,
		r.supplier.contactName,
		r.supplier.email,
		r.supplier.city,
		...r.catalogs.map((c) => c.name),
	]
		.filter(Boolean)
		.join(" ")
		.toLowerCase();

function Suppliers() {
	const rows = Route.useLoaderData();
	const { q = "", sort = "name", desc } = Route.useSearch();
	const navigate = useNavigate({ from: Route.fullPath });
	const searchBox = useRef<HTMLInputElement>(null);
	useHotkeys({
		"/": (e) => {
			e.preventDefault();
			searchBox.current?.focus();
		},
	});
	const now = new Date();
	const { get, desc: firstDesc } = SORTS[sort];
	const down = desc ?? firstDesc;

	const words = q.toLowerCase().split(/\s+/).filter(Boolean);
	const shown = rows
		.filter((r) => {
			const hay = haystack(r);
			return words.every((w) => hay.includes(w));
		})
		.sort((a, b) => {
			const x = get(a);
			const y = get(b);
			// Nothing to sort by goes last whichever way.
			if (x === null || y === null) return x === y ? 0 : x === null ? 1 : -1;
			const c = x < y ? -1 : x > y ? 1 : 0;
			return (down ? -c : c) || a.supplier.name.localeCompare(b.supplier.name);
		});
	const spend = shown.reduce((n, r) => n + r.spendYear, 0);

	const sortBy = (key: SortKey) =>
		navigate({
			search: (s) => ({
				...s,
				sort: key === "name" ? undefined : key,
				desc: key === sort ? !down : undefined,
			}),
			replace: true,
		});

	return (
		<Page
			title="Suppliers"
			back={{ to: "/purchasing" }}
			actions={
				<Button asChild variant="outline" size="sm">
					<Link to="/purchasing/catalogs">
						<BookOpen />
						Catalogs
					</Link>
				</Button>
			}
		>
			<div className="flex items-center gap-3">
				<div className="relative max-w-md flex-1">
					<Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
					<input
						ref={searchBox}
						value={q}
						onChange={(e) =>
							navigate({
								search: (s) => ({ ...s, q: e.target.value || undefined }),
								replace: true,
							})
						}
						onKeyDown={(e) => {
							if (e.key === "Escape") e.currentTarget.blur();
						}}
						placeholder="Search by name, contact, email, or catalog"
						aria-label="Search suppliers"
						className="h-9 w-full rounded-lg border border-input bg-white pr-8 pl-8 outline-none focus:border-ring"
					/>
					{q && (
						<button
							type="button"
							aria-label="Clear search"
							onClick={() =>
								navigate({ search: (s) => ({ ...s, q: undefined }) })
							}
							className="absolute top-1/2 right-1.5 -translate-y-1/2 rounded p-1 text-muted-foreground hover:bg-subtle"
						>
							<X className="size-3.5" />
						</button>
					)}
				</div>
				<span className="text-muted-foreground tabular-nums">
					{shown.length === rows.length
						? `${formatCount(rows.length)} suppliers`
						: `${formatCount(shown.length)} of ${formatCount(rows.length)}`}
					{spend > 0 && ` · ${formatMoney(spend / 100)} this year`}
				</span>
			</div>
			<Card flush className="overflow-clip">
				<table className="w-full">
					<thead className="sticky top-14 z-10">
						<tr className="border-b bg-subtle text-left text-xs text-muted-foreground">
							<Header k="name" label="Supplier" {...{ sort, down, sortBy }} />
							<Header
								k="catalogs"
								label="Catalogs"
								className="hidden lg:table-cell"
								{...{ sort, down, sortBy }}
							/>
							<Header
								k="products"
								label="Products"
								align="right"
								{...{ sort, down, sortBy }}
							/>
							<Header
								k="open"
								label="On order"
								align="right"
								className="hidden md:table-cell"
								{...{ sort, down, sortBy }}
							/>
							<Header
								k="last"
								label="Last PO"
								className="hidden md:table-cell"
								{...{ sort, down, sortBy }}
							/>
							<Header
								k="spend"
								label="Spent, 12 mo"
								align="right"
								tip="Sent POs over the past year, after discounts"
								{...{ sort, down, sortBy }}
							/>
							<Header
								k="lead"
								label="Lead time"
								align="right"
								className="hidden xl:table-cell"
								{...{ sort, down, sortBy }}
							/>
							<Header
								k="threshold"
								label="Threshold"
								align="right"
								className="hidden xl:table-cell"
								tip="Spend at which a suggested PO is ready"
								{...{ sort, down, sortBy }}
							/>
						</tr>
					</thead>
					<tbody>
						{shown.map((r) => (
							<Row key={r.supplier.id} r={r} now={now} />
						))}
						{shown.length === 0 && (
							<tr>
								<td
									colSpan={8}
									className="px-4 py-10 text-center text-muted-foreground"
								>
									No supplier matches “{q}”
								</td>
							</tr>
						)}
					</tbody>
				</table>
			</Card>
		</Page>
	);
}

function Header({
	k,
	label,
	align,
	tip,
	className,
	sort,
	down,
	sortBy,
}: {
	k: SortKey;
	label: string;
	align?: "right";
	tip?: string;
	className?: string;
	sort: SortKey;
	down: boolean;
	sortBy: (k: SortKey) => void;
}) {
	const on = sort === k;
	const Arrow = down ? ArrowDown : ArrowUp;
	return (
		<th
			aria-sort={on ? (down ? "descending" : "ascending") : undefined}
			className={cn("px-4 py-0 font-medium whitespace-nowrap", className)}
		>
			<Tip content={tip}>
				<button
					type="button"
					onClick={() => sortBy(k)}
					className={cn(
						"group inline-flex h-9 w-full items-center gap-1 hover:text-foreground",
						align === "right" && "justify-end",
						on && "text-foreground",
					)}
				>
					{label}
					{on ? (
						<Arrow className="size-3.5 text-link" />
					) : (
						<ArrowDown className="size-3.5 opacity-0 transition-opacity group-hover:opacity-40" />
					)}
				</button>
			</Tip>
		</th>
	);
}

function Row({ r, now }: { r: SupplierTableRow; now: Date }) {
	const { link } = useRowLink();
	const s = r.supplier;
	return (
		<tr
			{...link({
				to: "/purchasing/suppliers/$id",
				params: { id: String(s.id) },
			})}
			className="cursor-pointer border-t first:border-t-0 hover:bg-subtle"
		>
			<td className="w-full max-w-0 min-w-56 px-4 py-2.5">
				<div className="flex items-center gap-2">
					<Link
						to="/purchasing/suppliers/$id"
						params={{ id: String(s.id) }}
						className="truncate font-medium hover:underline"
					>
						{s.name}
					</Link>
					{r.draftId !== null && (
						<Link
							to="/purchasing/$id"
							params={{ id: String(r.draftId) }}
							className="shrink-0"
						>
							<Badge tone="info">Draft</Badge>
						</Link>
					)}
					{!s.email && <Badge tone="warning">No email</Badge>}
				</div>
				<div className="truncate text-xs text-muted-foreground">
					{[s.code, s.contactName].filter(Boolean).join(" · ")}
				</div>
			</td>
			<td className="hidden px-4 py-2.5 lg:table-cell">
				<Catalogs list={r.catalogs} />
			</td>
			<td className="px-4 py-2.5 text-right tabular-nums">
				{formatCount(r.products)}
			</td>
			<td className="hidden px-4 py-2.5 text-right tabular-nums md:table-cell">
				{r.openOrders > 0 ? (
					formatCount(r.openOrders)
				) : (
					<span className="text-faint">0</span>
				)}
			</td>
			<td className="hidden px-4 py-2.5 whitespace-nowrap md:table-cell">
				{r.lastSentAt ? (
					<Tip content={formatDay(r.lastSentAt)}>
						<span>{ago(r.lastSentAt, now)}</span>
					</Tip>
				) : (
					<span className="text-faint">Never</span>
				)}
			</td>
			<td className="px-4 py-2.5 text-right whitespace-nowrap tabular-nums">
				{r.spendYear > 0 ? (
					formatMoney(r.spendYear / 100)
				) : (
					<span className="text-faint">None</span>
				)}
			</td>
			<td className="hidden px-4 py-2.5 text-right whitespace-nowrap tabular-nums xl:table-cell">
				<Tip
					content={
						r.leadTime.measured
							? `Measured from ${r.leadTime.measured.pos} POs (typed: ${r.leadTime.configured})`
							: `Typed in; measured after ${MIN_MEASURED_POS} received POs`
					}
				>
					<span>
						{r.leadTime.days} days
						{r.leadTime.measured && (
							<span className="ml-1 text-xs text-success-text">measured</span>
						)}
					</span>
				</Tip>
			</td>
			<td className="hidden px-4 py-2.5 text-right tabular-nums xl:table-cell">
				{s.minimumOrder > 0 ? (
					formatMoney(s.minimumOrder)
				) : (
					<span className="text-faint">None</span>
				)}
			</td>
		</tr>
	);
}

// Up to two catalogs by name, the rest as a count with their names on hover.
function Catalogs({ list }: { list: SupplierTableRow["catalogs"] }) {
	if (list.length === 0) return <span className="text-faint">None</span>;
	const rest = list.slice(2);
	return (
		<div className="flex max-w-72 items-center gap-1.5">
			{list.slice(0, 2).map((c) => (
				<span
					key={c.id}
					className="inline-flex min-w-0 items-center gap-1 rounded-md bg-subtle py-0.5 pr-1.5 pl-0.5 text-xs"
				>
					<CatalogMark catalog={c} size="xs" />
					<span className="truncate">{c.name}</span>
				</span>
			))}
			{rest.length > 0 && (
				<Tip content={rest.map((c) => c.name).join(", ")}>
					<span className="shrink-0 text-xs text-muted-foreground">
						+{rest.length}
					</span>
				</Tip>
			)}
		</div>
	);
}
