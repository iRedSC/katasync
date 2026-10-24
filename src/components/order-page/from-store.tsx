import { Badge } from "#/components/page";
import { formatCount } from "#/lib/format";
import type { FromStore } from "#/orders/from-store";

// Says to fetch what a line took from the retail store, because the
// warehouse was out when the order came in. Just the count when it's the
// line's own product, the parts when it's a tool set.
export function FromStoreBadge({
	parts,
	sku,
}: {
	parts: FromStore;
	sku: string | null;
}) {
	if (parts === null)
		return <Badge tone="info">Shelf assigned at dispatch</Badge>;
	if (parts.length === 0) return null;
	const where = parts[0].location;
	const own = parts.length === 1 && parts[0].sku === sku;
	return (
		<Badge tone="warning">
			{own
				? `Fetch ${formatCount(parts[0].quantity)} from ${where}`
				: `Fetch from ${where}: ${parts.map((p) => `${p.sku} × ${formatCount(p.quantity)}`).join(", ")}`}
		</Badge>
	);
}
