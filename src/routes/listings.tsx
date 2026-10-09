import { createFileRoute } from "@tanstack/react-router";
import { Link2 } from "lucide-react";
import { EmptyState, PageBody, PageHeader, StatusDot } from "#/components/page";
import { listUnmappedListings } from "#/server/catalog";

export const Route = createFileRoute("/listings")({
	loader: () => listUnmappedListings(),
	component: Listings,
});

function Listings() {
	const unmapped = Route.useLoaderData();
	return (
		<>
			<PageHeader title="Listings" />
			<PageBody>
				{unmapped.length === 0 ? (
					<EmptyState icon={Link2} title="Every listing is matched">
						When a store adds a listing katasync can't match to a product on its
						own, it waits here for you.
					</EmptyState>
				) : (
					<ul className="flex flex-col">
						{unmapped.map((l) => (
							<li
								key={l.id}
								className="flex items-center gap-4 border-b py-3 last:border-0"
							>
								<div className="min-w-0 flex-1">
									<div className="truncate">{l.title}</div>
									<div className="text-xs text-muted-foreground">
										{l.store}
										{l.externalSku && (
											<span className="font-mono"> · {l.externalSku}</span>
										)}
									</div>
								</div>
								<StatusDot tone="warn">Needs a product</StatusDot>
							</li>
						))}
					</ul>
				)}
			</PageBody>
		</>
	);
}
