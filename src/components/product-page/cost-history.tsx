import { ArrowRight } from "lucide-react";
import { Card } from "#/components/page";
import { formatCount, formatDate, formatMoney } from "#/lib/format";
import type { ProductDetail } from "#/server/catalog";

type Entry = ProductDetail["costHistory"][number];

// What happened, in a few words.
function what(e: Entry) {
	const n = formatCount(Math.abs(e.units));
	switch (e.kind) {
		case "opening":
			return "When costs began being kept";
		case "set":
			return e.note === "Written directly"
				? "Imported"
				: (e.note ?? "Set by hand");
		case "receipt":
			return `${n} in on ${e.note ?? "a PO"}`;
		case "po_correction":
			return `${e.note ?? "A PO"} changed`;
		case "return":
			return `${n} returned`;
		case "kit_build":
			return `${n} built`;
		case "kit_break":
			return `${n} from kits taken apart`;
		case "undo":
			return `${n} taken back off`;
	}
}

// Every change to the product's average cost, newest first, so any cost can
// be traced to what made it.
export function CostHistory({ d }: { d: ProductDetail }) {
	if (d.product.kind === "bundle" || d.costHistory.length === 0) return null;
	return (
		<Card title="Cost history">
			<ul className="flex flex-col gap-1.5">
				{d.costHistory.map((e) => (
					<li
						key={e.id}
						className="grid grid-cols-[auto_1fr_auto] items-baseline gap-x-3"
					>
						<span className="text-muted-foreground tabular-nums">
							{formatDate(e.createdAt)}
						</span>
						<span className="min-w-0 truncate">
							{what(e)}
							{e.soldValue !== 0 && (
								<span className="ml-1.5 text-muted-foreground">
									{formatMoney(e.soldValue)} on sold
								</span>
							)}
						</span>
						<span className="flex items-center gap-1 tabular-nums">
							{e.avgBefore !== e.avgAfter && (
								<>
									<span className="text-muted-foreground">
										{e.avgBefore === null ? "none" : formatMoney(e.avgBefore)}
									</span>
									<ArrowRight className="size-3 text-muted-foreground" />
								</>
							)}
							{e.avgAfter === null ? "none" : formatMoney(e.avgAfter)}
						</span>
					</li>
				))}
			</ul>
		</Card>
	);
}
