import { Link } from "@tanstack/react-router";
import { HoverCard } from "radix-ui";
import { FromStoreBadge } from "#/components/order-page/from-store";
import { ProductImage } from "#/components/product";
import { formatCount } from "#/lib/format";
import { cn } from "#/lib/utils";
import { partlyShipped, shippedOf } from "#/orders/remaining";
import type { OrderRow } from "#/server/orders";

// Units already shipped come only with orders still to ship; a list of
// returns has none to show.
type Line = Omit<OrderRow["lines"][number], "shippedQuantity"> & {
	shippedQuantity?: number | null;
};

// What each line shows: what's left to ship once part of the order went
// out, else what sold.
function shownLines(lines: readonly Line[]) {
	const counted = lines.map((l) => ({
		...l,
		shippedQuantity: l.shippedQuantity ?? null,
	}));
	if (!partlyShipped(counted)) return lines.map((l) => ({ ...l, left: null }));
	return counted.map((l) => ({ ...l, left: l.quantity - shippedOf(l) }));
}

// Katasync's name for what sold; the marketplace's long listing title only
// until the line is mapped to a product.
const nameOf = (l: Line) => l.productName ?? l.title;

// What an order is, at a glance: one product's photo, name, and quantity, or
// up to three photos, a +N square for the rest, and how many products.
// Hovering lists every line. Clicking still opens the order, as anywhere else
// on its row.
export function OrderProducts({ lines: sold }: { lines: readonly Line[] }) {
	const lines = shownLines(sold);
	const [first] = lines;
	if (!first) return <span className="text-faint">No products</span>;
	const items = lines.reduce((n, l) => n + (l.left ?? l.quantity), 0);
	const firstCount = first.left ?? first.quantity;
	return (
		<HoverCard.Root openDelay={150} closeDelay={100}>
			<HoverCard.Trigger asChild>
				<div className="@container flex min-w-0 items-center gap-2">
					<Photos lines={lines} />
					{lines.length === 1 ? (
						<span className="min-w-0">
							<span className="block truncate">{nameOf(first)}</span>
							{first.variantName && (
								<span className="block truncate text-xs text-muted-foreground">
									{first.variantName}
								</span>
							)}
						</span>
					) : (
						<span className="truncate text-muted-foreground">
							{formatCount(lines.length)} products
						</span>
					)}
					{lines.length === 1 && (firstCount > 1 || first.left !== null) && (
						<span className="shrink-0 font-semibold tabular-nums">
							× {formatCount(firstCount)}
							{first.left !== null && (
								<span className="font-normal text-muted-foreground">
									{" "}
									of {formatCount(first.quantity)}
								</span>
							)}
						</span>
					)}
				</div>
			</HoverCard.Trigger>
			<HoverCard.Portal>
				<HoverCard.Content
					side="bottom"
					align="start"
					sideOffset={6}
					collisionPadding={12}
					// The row behind opens the order; a click in here is for a product.
					onClick={(e) => e.stopPropagation()}
					className="z-50 flex max-h-(--radix-hover-card-content-available-height) w-[26rem] flex-col gap-3 rounded-xl bg-popover p-4 text-sm whitespace-normal text-popover-foreground shadow-lg ring-1 ring-black/10"
				>
					<div>
						<p className="text-base leading-snug font-semibold">
							{formatCount(lines.length)}{" "}
							{lines.length === 1 ? "product" : "products"}
						</p>
						<p className="text-xs text-muted-foreground">
							{formatCount(items)} {items === 1 ? "item" : "items"}
						</p>
					</div>
					<ul className="-mx-4 flex min-h-0 flex-col overflow-y-auto">
						{lines.map((l) => (
							<LineRow key={l.id} line={l} />
						))}
					</ul>
				</HoverCard.Content>
			</HoverCard.Portal>
		</HoverCard.Root>
	);
}

// How many squares fit beside the "N products" label, by the cell's width.
// Each wider step fits one more. Tailwind only sees literal class names, so
// every step is spelled out.
const SQUARES = [1, 2, 3, 4] as const;
type Squares = (typeof SQUARES)[number];
const AT_LEAST: Record<Squares, string> = {
	1: "block",
	2: "hidden @min-[10.5rem]:block",
	3: "hidden @min-[12.75rem]:block",
	4: "hidden @min-[15rem]:block",
};
const EXACTLY: Record<Squares, string> = {
	1: "flex @min-[10.5rem]:hidden",
	2: "hidden @min-[10.5rem]:@max-[12.75rem]:flex",
	3: "hidden @min-[12.75rem]:@max-[15rem]:flex",
	4: "hidden @min-[15rem]:flex",
};

// With room for s squares, every photo shows when they all fit; otherwise
// s - 1 photos and a +N square for the rest. As the cell narrows, the +N
// square eats photos until it is the only square left.
function Photos({ lines }: { lines: readonly Line[] }) {
	const max = SQUARES.length - 1;
	const photos = lines.slice(0, max);
	return (
		<div className="flex shrink-0 gap-1">
			{photos.map((l, i) => (
				// Photo i shows once there is room for it and a +N after it, or
				// for every photo.
				<span
					key={l.id}
					className={AT_LEAST[Math.min(i + 2, lines.length) as Squares]}
				>
					<ProductImage src={l.imageUrl} className="size-8" />
				</span>
			))}
			{SQUARES.filter((s) => lines.length > Math.min(s, max)).map((s) => (
				<span
					key={s}
					className={cn(
						EXACTLY[s],
						"size-8 items-center justify-center rounded-lg border bg-subtle text-xs font-semibold text-muted-foreground tabular-nums",
					)}
				>
					+{formatCount(lines.length - s + 1)}
				</span>
			))}
		</div>
	);
}

function LineRow({ line }: { line: Line & { left: number | null } }) {
	const cancelled = line.quantity === 0;
	const sent = line.left === 0;
	const body = (
		<>
			<ProductImage src={line.imageUrl} className="size-8" />
			<div
				className={cn("min-w-0 flex-1", cancelled && "text-muted-foreground")}
			>
				<p className="line-clamp-2 font-medium">{nameOf(line)}</p>
				{line.variantName && (
					<p className="text-xs font-semibold">{line.variantName}</p>
				)}
				<p className="text-xs text-muted-foreground">
					{line.sku ?? "No SKU"}
					{line.productSku && line.sku !== line.productSku && (
						<> → {line.productSku}</>
					)}
				</p>
				{(line.fromStore === null || line.fromStore.length > 0) && (
					<div className="mt-1">
						<FromStoreBadge parts={line.fromStore} sku={line.productSku} />
					</div>
				)}
			</div>
			<span
				className={cn(
					"shrink-0 tabular-nums",
					cancelled ? "text-muted-foreground" : "font-semibold",
				)}
			>
				{cancelled ? (
					"Cancelled"
				) : sent ? (
					<span className="font-normal text-muted-foreground">Shipped</span>
				) : (
					<>
						× {formatCount(line.left ?? line.quantity)}
						{line.left !== null && (
							<span className="font-normal text-muted-foreground">
								{" "}
								of {formatCount(line.quantity)}
							</span>
						)}
					</>
				)}
			</span>
		</>
	);
	const row = "flex items-center gap-3 px-4 py-2";
	return (
		<li className="border-b last:border-b-0">
			{line.productSku ? (
				<Link
					to="/products/$sku"
					params={{ sku: line.productSku }}
					className={cn(row, "hover:bg-subtle")}
				>
					{body}
				</Link>
			) : (
				<div className={row}>{body}</div>
			)}
		</li>
	);
}
