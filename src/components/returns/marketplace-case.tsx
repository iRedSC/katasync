import { ExternalLink } from "lucide-react";
import { Badge } from "#/components/page";
import type { marketplaceCases, openCases } from "#/db/schema";
import { CaseObligation } from "./case-obligation";

const LABELS = {
	return: "Return asked",
	refund: "Refund asked",
	inquiry: "Not received",
	cancellation: "Cancel request",
	dispute: "Dispute",
	claim: "Guarantee claim",
	escalation: "eBay case",
} satisfies Record<typeof openCases.$inferSelect.kind, string>;
export const caseKindLabel = (kind: keyof typeof LABELS) => LABELS[kind];

export function MarketplaceCaseCard({
	request,
}: {
	request: typeof marketplaceCases.$inferSelect & {
		page: { url: string; name: string } | null;
	};
}) {
	return (
		<div className="flex flex-wrap items-center gap-2 border-t py-3">
			<Badge tone={request.waitingOn === "us" ? "warning" : undefined}>
				{caseKindLabel(request.kind)}
			</Badge>
			<span className="text-xs text-muted-foreground">
				{request.caseRef ?? request.externalId}
			</span>
			<CaseObligation request={request} />
			{request.nextAction && (
				<span className="text-xs text-muted-foreground">
					{request.nextAction}
				</span>
			)}
			{request.page && (
				<a
					href={request.page.url}
					target="_blank"
					rel="noreferrer"
					className="ml-auto inline-flex items-center gap-1 text-sm text-link"
				>
					{request.actionUrl ? "Open case" : "Open order"} on eBay{" "}
					<ExternalLink className="size-3" />
				</a>
			)}
		</div>
	);
}
