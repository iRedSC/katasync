import { Ban, ExternalLink } from "lucide-react";
import { ChannelBadge } from "#/components/channel-badge";
import { OrderProducts } from "#/components/orders-list/order-products";
import { Badge } from "#/components/page";
import { Button } from "#/components/ui/button";
import { Tip } from "#/components/ui/tooltip";
import { formatCount, formatOrderDate } from "#/lib/format";
import type { useRowLink } from "#/lib/row-link";
import { cn } from "#/lib/utils";
import type { AdminPage } from "#/orders/admin-urls";
import { returnReason } from "#/orders/return-reasons";
import type { Situation } from "#/orders/return-situation";
import type { ReturnOrder } from "#/orders/returns-due";
import { CaseObligation } from "./case-obligation";
import { ItemCell, RefundCell } from "./return-cells";
import { ReturnEvidence } from "./return-evidence";

export const ICON_BUTTON =
	"inline-flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-surface-strong hover:text-foreground";

const LINK =
	"inline-flex h-7 shrink-0 items-center gap-1 rounded-md px-2 text-sm text-link hover:bg-surface-strong";

function Outside({ page, verb }: { page: AdminPage | null; verb: string }) {
	if (!page) return null;
	return (
		<a href={page.url} target="_blank" rel="noreferrer" className={LINK}>
			{verb} on {page.name}
			<ExternalLink className="size-3.5" />
		</a>
	);
}

// One order's return: what's coming, where it is, the refund, and the one
// thing to do next. A click opens the order, where its whole return is.
export function ReturnRow({
	order: o,
	situation: s,
	onReceive,
	onNothing,
	link,
}: {
	order: ReturnOrder;
	situation: Situation;
	onReceive: () => void;
	onNothing?: () => void;
	link: ReturnType<typeof useRowLink>["link"];
}) {
	const request = o.requests[0];
	const deadline = o.requests.find((r) => r.waitingOn === "us" && r.respondBy);
	const expected = o.lines.filter((l) => l.expected > 0);
	const coming = (expected.length > 0 ? expected : o.lines).map((l) => ({
		id: l.id,
		title: l.title,
		sku: l.sku,
		quantity: l.expected || l.left,
		productSku: null,
		productName: null,
		variantName: null,
		imageUrl: l.imageUrl,
		fromStore: [],
	}));
	const n = s.next.kind;
	const canReceive = !o.blocker && o.lines.length > 0;
	return (
		<tr
			{...link({ to: "/orders/$id", params: { id: String(o.id) } })}
			className={cn(
				"cursor-pointer border-t first:border-t-0 hover:bg-subtle",
				n === "check_in" &&
					"bg-warning-fill/40 shadow-[inset_3px_0_0_var(--color-amber-500)]",
			)}
		>
			<td className="px-4 py-2.5">
				<div className="flex items-center gap-1.5 font-semibold">
					{o.name}
					<ChannelBadge channel={o.channel} salesChannel={o.salesChannel} />
				</div>
				<div className="text-xs text-muted-foreground">
					{formatOrderDate(o.placedAt)}
				</div>
			</td>
			<td className="hidden w-1/5 max-w-0 px-4 py-2.5 md:table-cell">
				<div className="truncate">{o.customerName ?? "No name"}</div>
				<div className="truncate text-xs text-muted-foreground">
					{[o.shipCity, o.shipRegion].filter(Boolean).join(", ")}
					{o.shipPostalCode && ` ${o.shipPostalCode}`}
				</div>
			</td>
			<td className="w-2/5 max-w-0 px-4 py-2">
				<OrderProducts lines={coming} />
				{request?.reason && (
					<div className="truncate text-xs text-muted-foreground">
						{returnReason(request.reason)}
					</div>
				)}
				{o.unmatched.map((u, i) => (
					<div
						// biome-ignore lint/suspicious/noArrayIndexKey: two requests can name the same SKU
						key={i}
						className="truncate text-xs text-warning-text"
					>
						{formatCount(u.quantity)} × {u.sku ?? "an item"}, line unclear
					</div>
				))}
			</td>
			<td className="max-w-48 px-4 py-2.5">
				<ItemCell item={s.item} order={o} />
				<div className="mt-1 flex flex-wrap gap-1 empty:hidden">
					{request && <ReturnEvidence evidence={request} />}
					{o.blocker && (
						<Tip content={o.blocker}>
							<span>
								<Badge tone="warning">Can't receive here</Badge>
							</span>
						</Tip>
					)}
				</div>
			</td>
			<td className="hidden max-w-40 px-4 py-2.5 sm:table-cell">
				<RefundCell refund={s.refund} due={n === "refund"} />
			</td>
			<td className="py-1.5 pr-2">
				<div className="flex items-center justify-end gap-1">
					{deadline && (
						<CaseObligation
							request={{ ...deadline, amount: null, currency: null }}
						/>
					)}
					{n === "check_in" && canReceive && (
						<Button size="sm" onClick={onReceive}>
							Check in
						</Button>
					)}
					{s.next.kind === "answer" && (
						<Outside page={s.next.on} verb="Answer" />
					)}
					{s.next.kind === "refund" && (
						<Outside page={s.next.on} verb="Refund" />
					)}
					{s.next.kind === "close" && <Outside page={s.next.on} verb="Close" />}
					{n !== "check_in" &&
						n !== "close" &&
						n !== "refund" &&
						canReceive && (
							<Button size="sm" variant="outline" onClick={onReceive}>
								Receive
							</Button>
						)}
					{onNothing ? (
						<Tip content="Nothing coming back">
							<button
								type="button"
								aria-label="Nothing coming back"
								onClick={onNothing}
								className={ICON_BUTTON}
							>
								<Ban className="size-4" />
							</button>
						</Tip>
					) : (
						<span className="size-7" />
					)}
				</div>
			</td>
		</tr>
	);
}
