import { ExternalLink } from "lucide-react";
import { useEffect, useState } from "react";
import type { BuyerOrder } from "#/buyers/order";
import { PackageDetails } from "#/components/package-status";
import { Card } from "#/components/page";
import { Bone } from "#/components/skeleton";
import { getOrderPackages } from "#/server/orders";

// Where each package is, scan by scan: katasync's labels and those bought
// on the channel's own site. Asked as the page opens; nothing shows for an
// order that hasn't gone out.

type Package = BuyerOrder["packages"][number];

export function TrackingCard({ orderId }: { orderId: number }) {
	const [packages, setPackages] = useState<Package[] | null>(null);
	useEffect(() => {
		let current = true;
		setPackages(null);
		getOrderPackages({ data: { id: orderId } })
			.then((p) => current && setPackages(p))
			.catch(() => current && setPackages([]));
		return () => {
			current = false;
		};
	}, [orderId]);
	if (packages === null)
		return (
			<Card title="Tracking">
				<Bone className="h-24" />
			</Card>
		);
	if (packages.length === 0) return null;
	return (
		<Card title="Tracking">
			<div className="flex flex-col gap-5 animate-in fade-in-0">
				{packages.map((p) =>
					p.tracking ? (
						<PackageDetails key={p.key} t={p.tracking} />
					) : (
						<p key={p.key} className="text-sm">
							{p.url ? (
								<a
									href={p.url}
									target="_blank"
									rel="noreferrer"
									className="inline-flex items-center gap-1 font-mono text-link hover:underline"
								>
									{p.carrier} {p.number}
									<ExternalLink className="size-3" />
								</a>
							) : (
								<span className="font-mono">
									{p.carrier} {p.number ?? "No tracking number"}
								</span>
							)}
						</p>
					),
				)}
			</div>
		</Card>
	);
}
