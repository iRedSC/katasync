import { Link } from "@tanstack/react-router";
import { Bot, Info, Languages, Package, Truck } from "lucide-react";
import { useState } from "react";
import type { MarketplaceMessage } from "#/buyers/marketplace-messages";
import { ProductImage } from "#/components/product";
import { Tip } from "#/components/ui/tooltip";
import { formatDateTime, formatMoney } from "#/lib/format";
import { cn } from "#/lib/utils";
import type { Market } from "#/markets/market";

// What the marketplace itself put in the conversation, on our side (it
// speaks as the shop) but plainly not ours: its assistant's answers dashed,
// its notices as a line between messages, its cards with the order they
// name. Kinds only its own site shows are one line however many.

const NAMES: Partial<Record<Market, string>> = { tiktok: "TikTok" };

// Runs of "other" become one entry, counted.
export type MarketplaceShown =
	| { key: string; at: Date; message: MarketplaceMessage }
	| { key: string; at: Date; others: number };

export function groupMarketplace(messages: MarketplaceMessage[]) {
	const shown: MarketplaceShown[] = [];
	for (const m of messages) {
		const last = shown.at(-1);
		if (m.kind === "other" && last && "others" in last) last.others++;
		else if (m.kind === "other")
			shown.push({ key: `o${m.id}`, at: m.at, others: 1 });
		else shown.push({ key: `k${m.id}`, at: m.at, message: m });
	}
	return shown;
}

export function MarketplaceBubble({
	item,
	market,
}: {
	item: MarketplaceShown;
	market: Market;
}) {
	const name = NAMES[market] ?? "The marketplace";
	if ("others" in item)
		return (
			<p className="text-center text-xs text-muted-foreground">
				{item.others > 1 ? `${item.others} messages` : "A message"} only {name}
				's Seller Center shows
			</p>
		);
	const m = item.message;
	if (m.kind === "notice")
		return (
			<p className="flex items-center justify-center gap-1 text-center text-xs text-muted-foreground">
				<Info className="size-3 shrink-0" />
				{m.english ?? m.body}
			</p>
		);
	if (m.kind === "assistant") return <Assistant message={m} name={name} />;
	return <Card message={m} name={name} />;
}

function Assistant({
	message: m,
	name,
}: {
	message: MarketplaceMessage;
	name: string;
}) {
	const [original, setOriginal] = useState(false);
	const translated = Boolean(m.english) && !original;
	return (
		<div className="flex flex-col items-end gap-1">
			<div className="max-w-[85%] rounded-2xl rounded-br-md border border-dashed px-3.5 py-2 whitespace-pre-wrap break-words text-muted-foreground">
				{translated ? m.english : m.body}
			</div>
			<span className="flex items-center gap-1 text-xs text-muted-foreground">
				<Bot className="size-3" />
				{name}'s assistant, not you · {formatDateTime(m.at)}
				{m.english && (
					<button
						type="button"
						onClick={() => setOriginal((o) => !o)}
						className="inline-flex items-center gap-1 rounded px-1 hover:bg-surface hover:text-foreground"
					>
						<Languages className="size-3" />
						{translated ? "Original" : "English"}
					</button>
				)}
			</span>
		</div>
	);
}

function Card({
	message: m,
	name,
}: {
	message: MarketplaceMessage;
	name: string;
}) {
	const shipping = m.kind === "shipping_card";
	const Icon = shipping ? Truck : Package;
	const o = m.order;
	return (
		<div className="flex flex-col items-end gap-1">
			<div className="w-72 max-w-[85%] rounded-xl border bg-surface p-2.5 text-sm">
				<p className="mb-2 flex items-center gap-1.5 font-medium">
					<Icon className="size-4" />
					{shipping ? "Shipping update" : "Order"}
				</p>
				{o ? (
					<Link
						to="/orders/$id"
						params={{ id: String(o.id) }}
						className="flex items-center gap-2 rounded-md p-1 hover:bg-surface-strong"
					>
						<ProductImage src={o.imageUrl} className="size-10" />
						<span className="min-w-0">
							<span className="block truncate">{o.title ?? o.name}</span>
							<span className="text-xs text-muted-foreground">
								{o.name} · {o.items} {o.items === 1 ? "item" : "items"} ·{" "}
								{formatMoney(o.total)}
							</span>
						</span>
					</Link>
				) : (
					<Tip content="Not in katasync yet">
						<p className={cn("text-muted-foreground tabular-nums")}>
							{m.orderRef}
						</p>
					</Tip>
				)}
			</div>
			<span className="text-xs text-muted-foreground">
				{name} · {formatDateTime(m.at)}
			</span>
		</div>
	);
}
