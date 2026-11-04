import { Badge } from "#/components/page";
import { Tip } from "#/components/ui/tooltip";
import { type PackBlock, whyNotPackable } from "#/orders/remaining";

// Why an order can't be packed yet, as a badge; hovering says what to do.
// Syncing clears on its own. The others need a person.
export function PackBlockBadge({ block }: { block: PackBlock }) {
	return (
		<Tip content={`Can't pack yet: ${whyNotPackable(block)}`}>
			<span>
				{block === "behind" ? (
					<Badge tone="info">Syncing</Badge>
				) : block === "short" ? (
					<Badge tone="critical">Fewer shipped</Badge>
				) : (
					<Badge tone="critical">? shipped</Badge>
				)}
			</span>
		</Tip>
	);
}
