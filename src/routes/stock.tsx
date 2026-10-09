import { createFileRoute, Link } from "@tanstack/react-router";
import { PageBody, PageHeader } from "#/components/page";
import { ProductImage } from "#/components/product";
import {
	formatCount,
	formatDateTime,
	formatDelta,
	formatReason,
} from "#/lib/format";
import { cn } from "#/lib/utils";
import { listMovementBatches } from "#/server/catalog";

export const Route = createFileRoute("/stock")({
	loader: () => listMovementBatches(),
	component: StockHistory,
});

function StockHistory() {
	const batches = Route.useLoaderData();
	return (
		<>
			<PageHeader title="Stock history" />
			<PageBody className="gap-2">
				<p className="pb-4 text-sm text-muted-foreground">
					Every change to stock, newest first. Mistakes are fixed with a new
					entry, never by editing an old one.
				</p>
				<ul className="flex flex-col">
					{batches.map((b) => {
						const single = b.lines === 1;
						const what = b.reasons.map(formatReason).join(" + ");
						const row = (
							<div className="-mx-2 flex items-center gap-4 rounded-lg px-2 py-3 hover:bg-accent">
								{single ? (
									<ProductImage src={b.imageUrl} className="size-9" />
								) : (
									<div className="flex size-9 shrink-0 items-center justify-center rounded-md bg-primary/10 text-xs font-semibold text-primary tabular-nums">
										{b.lines > 999 ? `${Math.round(b.lines / 1000)}k` : b.lines}
									</div>
								)}
								<div className="min-w-0 flex-1">
									<div className="truncate">
										{single
											? b.name
											: `${what} · ${formatCount(b.lines)} products`}
									</div>
									<div className="truncate text-xs text-muted-foreground">
										{single ? what : null}
										{b.note && (
											<>
												{single && " · "}
												{b.note}
											</>
										)}
										{!single && !b.note && b.reference}
									</div>
								</div>
								<div className="text-right">
									<div
										className={cn(
											"font-semibold tabular-nums",
											b.delta < 0 ? "text-bad" : "text-good",
										)}
									>
										{formatDelta(b.delta)}
									</div>
									<div className="text-xs whitespace-nowrap text-muted-foreground">
										{formatDateTime(b.createdAt)}
									</div>
								</div>
							</div>
						);
						return (
							<li key={b.batchId}>
								{single ? (
									<Link to="/products/$sku" params={{ sku: b.sku }}>
										{row}
									</Link>
								) : (
									row
								)}
							</li>
						);
					})}
				</ul>
			</PageBody>
		</>
	);
}
