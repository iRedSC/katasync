import { Link } from "@tanstack/react-router";
import { HoverCard } from "radix-ui";
import { ProductImage } from "#/components/product";
import { formatCount } from "#/lib/format";
import { cn } from "#/lib/utils";
import type { OrderRow } from "#/server/orders";

type Line = OrderRow["lines"][number];

// What an order is, at a glance: one product's photo and title, or the first
// photo and how many products. Hovering lists every line. Clicking still
// opens the order, as anywhere else on its row.
export function OrderProducts({ lines }: { lines: readonly Line[] }) {
	const [first] = lines;
	if (!first) return <span className="text-faint">No products</span>;
	const photo = lines.find((l) => l.imageUrl)?.imageUrl ?? null;
	const items = lines.reduce((n, l) => n + l.quantity, 0);
	return (
		<HoverCard.Root openDelay={150} closeDelay={100}>
			<HoverCard.Trigger asChild>
				<div className="flex min-w-0 items-center gap-2">
					<ProductImage src={photo} className="size-8" />
					<span
						className={cn(
							"truncate",
							lines.length > 1 && "text-muted-foreground",
						)}
					>
						{lines.length === 1
							? first.title
							: `${formatCount(lines.length)} products`}
					</span>
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

function LineRow({ line }: { line: Line }) {
	const cancelled = line.quantity === 0;
	const body = (
		<>
			<ProductImage src={line.imageUrl} className="size-8" />
			<div
				className={cn("min-w-0 flex-1", cancelled && "text-muted-foreground")}
			>
				<p className="line-clamp-2 font-medium">{line.title}</p>
				<p className="text-xs text-muted-foreground">
					{line.sku ?? "No SKU"}
					{line.productSku && line.sku !== line.productSku && (
						<> → {line.productSku}</>
					)}
				</p>
			</div>
			<span
				className={cn(
					"shrink-0 tabular-nums",
					cancelled ? "text-muted-foreground" : "font-semibold",
				)}
			>
				{cancelled ? "Cancelled" : `× ${formatCount(line.quantity)}`}
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
