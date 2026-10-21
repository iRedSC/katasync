import { Link } from "@tanstack/react-router";
import { CircleCheck, ExternalLink } from "lucide-react";
import { ChannelBadge } from "#/components/channel-badge";
import { Card } from "#/components/page";
import { ProductImage, ProductName } from "#/components/product";
import { formatCount, formatDateTime } from "#/lib/format";
import { cn } from "#/lib/utils";
import type { QueueEntry } from "#/markets/queue";

// What the marketplaces flagged, worst first. Each row opens to the
// marketplace's own words and the listings or orders it's about, each with
// a way to fix it there. Rows start closed: the titles say what's wrong,
// and the marketplace's explanation waits until someone opens one.

export function AttentionQueue({
	entries,
	showMarket,
}: {
	entries: QueueEntry[];
	// On the overview each row says which market it's from.
	showMarket: boolean;
}) {
	if (entries.length === 0)
		return (
			<Card>
				<p className="flex items-center gap-2 font-medium text-success-text">
					<CircleCheck className="size-4" />
					Nothing flagged
				</p>
			</Card>
		);
	return (
		<Card title="Needs attention" aside={formatCount(entries.length)} flush>
			<ul className="border-t">
				{entries.map((e) => (
					<li key={e.key} className="border-t first:border-t-0">
						<Entry entry={e} showMarket={showMarket} />
					</li>
				))}
			</ul>
		</Card>
	);
}

function Entry({
	entry: e,
	showMarket,
}: {
	entry: QueueEntry;
	showMarket: boolean;
}) {
	const risk = e.level === "at_risk";
	return (
		<details className="group">
			<summary
				className={cn(
					"flex cursor-pointer list-none items-center gap-3 border-l-4 px-4 py-2.5 hover:bg-subtle",
					risk ? "border-critical-icon" : "border-warning-icon",
				)}
			>
				{showMarket && (
					<ChannelBadge channel={e.market} salesChannel={null} compact />
				)}
				<span
					className={cn(
						"min-w-0 flex-1 font-medium",
						risk ? "text-critical-text" : "text-foreground",
					)}
				>
					{e.text}
				</span>
				{e.items.length > 0 && (
					<span className="rounded-md bg-surface-strong px-1.5 text-xs font-medium tabular-nums">
						{formatCount(e.items.length)}
					</span>
				)}
				<span className="text-muted-foreground transition-transform group-open:rotate-90">
					›
				</span>
			</summary>
			<div className="flex flex-col gap-2 bg-subtle/50 px-4 pt-1 pb-3 pl-8">
				{e.detail && <p className="text-muted-foreground">{e.detail}</p>}
				<div className="flex items-center gap-3 text-xs text-muted-foreground">
					{e.checkedAt && <span>As of {formatDateTime(e.checkedAt)}</span>}
					{e.href && (
						<a
							href={e.href}
							target="_blank"
							rel="noreferrer"
							className="inline-flex items-center gap-1 font-medium text-link hover:underline"
						>
							Open on the marketplace
							<ExternalLink className="size-3" />
						</a>
					)}
				</div>
				{e.items.length > 0 && (
					<ul className="overflow-hidden rounded-lg border bg-card">
						{e.items.map((i) => (
							<li
								key={i.ref}
								className="flex items-start gap-3 border-t px-3 py-2 first:border-t-0"
							>
								<ProductImage
									src={i.product?.imageUrl ?? null}
									className="size-9"
								/>
								<div className="min-w-0 flex-1">
									{i.product ? (
										<Link
											to="/products/$sku"
											params={{ sku: i.product.sku }}
											className="hover:underline"
										>
											<ProductName
												name={i.product.name}
												variantName={i.product.variantName}
											/>
										</Link>
									) : (
										<span className="font-medium">{i.label}</span>
									)}
									<div className="text-xs text-muted-foreground">{i.ref}</div>
									{i.detail && <p className="mt-0.5 text-xs">{i.detail}</p>}
								</div>
								{i.href && (
									<a
										href={i.href}
										target="_blank"
										rel="noreferrer"
										aria-label={`Fix ${i.ref} on the marketplace`}
										className="rounded-md p-1 text-muted-foreground hover:bg-surface-strong"
									>
										<ExternalLink className="size-4" />
									</a>
								)}
							</li>
						))}
					</ul>
				)}
			</div>
		</details>
	);
}
