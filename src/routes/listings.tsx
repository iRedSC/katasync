import { createFileRoute } from "@tanstack/react-router";
import { Link2 } from "lucide-react";
import { Badge, Card, EmptyState, Page } from "#/components/page";
import { listUnmappedListings } from "#/server/catalog";

export const Route = createFileRoute("/listings")({
	loader: () => listUnmappedListings(),
	component: Listings,
});

function Listings() {
	const unmapped = Route.useLoaderData();
	return (
		<Page title="Listings">
			<Card flush>
				{unmapped.length === 0 ? (
					<EmptyState icon={Link2} title="Every listing is matched">
						When a store adds a listing katasync can't match to a product on its
						own, it waits here for you.
					</EmptyState>
				) : (
					<ul>
						{unmapped.map((l) => (
							<li
								key={l.id}
								className="flex items-center gap-4 border-t px-4 py-2.5 first:border-t-0"
							>
								<div className="min-w-0 flex-1">
									<div className="truncate font-medium">{l.title}</div>
									<div className="flex gap-2 text-xs text-muted-foreground">
										<span>{l.store}</span>
										{l.externalSku && <span>{l.externalSku}</span>}
									</div>
								</div>
								<Badge tone="warning">Needs a product</Badge>
							</li>
						))}
					</ul>
				)}
			</Card>
		</Page>
	);
}
