import { createFileRoute } from "@tanstack/react-router";
import { Link2 } from "lucide-react";
import { EmptyState, PageBody, PageHeader } from "#/components/page";
import { Badge } from "#/components/ui/badge";
import { Button } from "#/components/ui/button";
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "#/components/ui/table";
import { listUnmappedListings } from "#/server/catalog";

export const Route = createFileRoute("/listings")({
	loader: () => listUnmappedListings(),
	component: Listings,
});

function Listings() {
	const unmapped = Route.useLoaderData();
	return (
		<>
			<PageHeader
				title="Listings"
				description="Tie each channel listing to the product it sells"
			/>
			<PageBody>
				{unmapped.length === 0 ? (
					<EmptyState icon={Link2} title="No listings to map">
						Once a channel syncs, its listings land here. Exact SKU matches (and
						Amazon -AMZ aliases) map themselves; the rest wait for you.
					</EmptyState>
				) : (
					<div className="rounded-lg border">
						<Table>
							<TableHeader>
								<TableRow>
									<TableHead>Store</TableHead>
									<TableHead>Listing</TableHead>
									<TableHead>Channel SKU</TableHead>
									<TableHead />
								</TableRow>
							</TableHeader>
							<TableBody>
								{unmapped.map((l) => (
									<TableRow key={l.id}>
										<TableCell>
											{l.store}{" "}
											{l.fulfillment === "fba" && (
												<Badge variant="outline">FBA</Badge>
											)}
										</TableCell>
										<TableCell className="max-w-md truncate">
											{l.title}
										</TableCell>
										<TableCell className="font-mono text-xs">
											{l.externalSku ?? "—"}
										</TableCell>
										<TableCell className="text-right">
											<Button size="sm" variant="outline" disabled>
												Map
											</Button>
										</TableCell>
									</TableRow>
								))}
							</TableBody>
						</Table>
					</div>
				)}
			</PageBody>
		</>
	);
}
