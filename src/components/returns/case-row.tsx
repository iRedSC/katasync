import { ExternalLink } from "lucide-react";
import { ChannelBadge } from "#/components/channel-badge";
import { OrderProducts } from "#/components/orders-list/order-products";
import { Badge } from "#/components/page";
import { Tip } from "#/components/ui/tooltip";
import { formatOrderDate } from "#/lib/format";
import type { useRowLink } from "#/lib/row-link";
import { returnReason } from "#/orders/return-reasons";
import type { CaseRequest } from "#/orders/returns-due";
import { CaseObligation } from "./case-obligation";
import { caseKindLabel } from "./marketplace-case";

export function CaseRow({
	request: r,
	link,
}: {
	request: CaseRequest;
	link: ReturnType<typeof useRowLink>["link"];
}) {
	return (
		<tr
			{...(r.orderId === null
				? {}
				: link({ to: "/orders/$id", params: { id: String(r.orderId) } }))}
			className="border-t first:border-t-0 hover:bg-subtle"
		>
			<td className="px-4 py-2.5 font-semibold">
				{r.name}
				{r.orderId === null && <Badge tone="warning">Order not imported</Badge>}
			</td>
			<td className="hidden px-4 py-2.5 text-muted-foreground md:table-cell">
				{formatOrderDate(r.requestedAt)}
			</td>
			<td className="w-2/5 max-w-0 px-4 py-2.5">
				<div className="truncate">{r.customerName ?? "No name"}</div>
				<div className="truncate text-xs text-muted-foreground">
					{[r.shipCity, r.shipRegion].filter(Boolean).join(", ")}
					{r.shipPostalCode && ` ${r.shipPostalCode}`}
				</div>
			</td>
			<td className="hidden w-3/5 max-w-0 px-4 py-2 md:table-cell">
				<OrderProducts
					lines={r.lines.map((l) => ({
						...l,
						productSku: null,
						productName: null,
						variantName: null,
						fromStore: [],
					}))}
				/>
			</td>
			<td className="hidden max-w-56 px-4 py-2.5 lg:table-cell">
				{r.reason && (
					<div className="truncate text-muted-foreground">
						{returnReason(r.reason)}
					</div>
				)}
				{r.note && (
					<Tip content={r.note}>
						<div className="truncate text-xs">“{r.note}”</div>
					</Tip>
				)}
			</td>
			<td className="hidden px-4 py-2.5 lg:table-cell">
				<ChannelBadge channel={r.channel} salesChannel={r.salesChannel} />
			</td>
			<td className="px-4 py-2.5">
				<div className="flex flex-col items-start gap-1">
					{(r.source === "marketplace" ||
						(r.status !== "unknown" && r.waitingOn === "us")) && (
						<Badge tone={r.waitingOn === "us" ? "warning" : undefined}>
							{caseKindLabel(r.kind)}
						</Badge>
					)}
					<CaseObligation request={r} />
					{r.source === "marketplace" && (
						<span className="text-xs text-muted-foreground">
							{r.externalId}
						</span>
					)}
				</div>
			</td>
			<td className="py-1.5 pr-2">
				<div className="flex items-center justify-end">
					{r.answerOn && (
						<a
							href={r.answerOn.url}
							target="_blank"
							rel="noreferrer"
							className="inline-flex h-7 shrink-0 items-center gap-1 rounded-md px-2 text-sm text-link hover:bg-surface-strong"
						>
							{r.source === "marketplace"
								? "Open"
								: r.waitingOn === "us"
									? "Answer"
									: "Open"}{" "}
							on {r.answerOn.name}
							<ExternalLink className="size-3.5" />
						</a>
					)}
				</div>
			</td>
		</tr>
	);
}
