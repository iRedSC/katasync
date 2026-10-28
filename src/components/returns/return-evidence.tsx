import { Badge } from "#/components/page";
import { Tip } from "#/components/ui/tooltip";
import { formatDay } from "#/lib/format";
import type { EvidenceChips } from "#/orders/return-evidence";

// What the marketplace's report adds about a return, as chips. The amount
// it refunded shows with the case (CaseObligation).
export function ReturnEvidence({ evidence: e }: { evidence: EvidenceChips }) {
	const claim = e.safetClaim;
	const reimbursed = claim?.reimbursement
		? new Intl.NumberFormat(undefined, {
				style: "currency",
				currency: claim.reimbursement.currency,
			}).format(Number(claim.reimbursement.amount))
		: null;
	const claimTip = [claim?.reason, reimbursed].filter(Boolean).join(" · ");
	return (
		<>
			{e.aToZClaim && <Badge tone="critical">A-to-z</Badge>}
			{claim && (
				<Tip content={claimTip || claim.id}>
					<span>
						<Badge tone="info">
							SAFE-T{claim.state ? ` ${claim.state.toLowerCase()}` : ""}
						</Badge>
					</span>
				</Tip>
			)}
			{e.inPolicy === false && <Badge tone="warning">Out of policy</Badge>}
			{e.deliveredAt && <Badge>Back {formatDay(e.deliveredAt)}</Badge>}
		</>
	);
}
