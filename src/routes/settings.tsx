import { createFileRoute } from "@tanstack/react-router";
import { PageBody, PageHeader } from "#/components/page";
import { Badge } from "#/components/ui/badge";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "#/components/ui/card";
import { Table, TableBody, TableCell, TableRow } from "#/components/ui/table";
import { listLocations, listStores } from "#/server/catalog";

export const Route = createFileRoute("/settings")({
	loader: async () => ({
		locations: await listLocations(),
		stores: await listStores(),
	}),
	component: Settings,
});

const channels = [
	{ id: "shopify", name: "Shopify" },
	{ id: "amazon", name: "Amazon" },
	{ id: "ebay", name: "eBay" },
	{ id: "tiktok", name: "TikTok Shop" },
] as const;

function Settings() {
	const { locations, stores } = Route.useLoaderData();
	return (
		<>
			<PageHeader title="Settings" />
			<PageBody>
				<div className="grid gap-4 lg:grid-cols-2">
					<Card>
						<CardHeader>
							<CardTitle>Channels</CardTitle>
							<CardDescription>Connected seller accounts</CardDescription>
						</CardHeader>
						<CardContent>
							<Table>
								<TableBody>
									{channels.map((c) => {
										const connected = stores.filter((s) => s.channel === c.id);
										return (
											<TableRow key={c.id}>
												<TableCell className="font-medium">{c.name}</TableCell>
												<TableCell className="text-right">
													{connected.length > 0 ? (
														<Badge>
															{connected.map((s) => s.name).join(", ")}
														</Badge>
													) : (
														<Badge variant="outline">Not connected</Badge>
													)}
												</TableCell>
											</TableRow>
										);
									})}
								</TableBody>
							</Table>
						</CardContent>
					</Card>
					<Card>
						<CardHeader>
							<CardTitle>Locations</CardTitle>
							<CardDescription>Where stock lives</CardDescription>
						</CardHeader>
						<CardContent>
							<Table>
								<TableBody>
									{locations.map((l) => (
										<TableRow key={l.id}>
											<TableCell className="font-medium">{l.name}</TableCell>
											<TableCell className="text-right">
												<Badge
													variant={l.kind === "fba" ? "outline" : "secondary"}
												>
													{l.kind === "fba" ? "FBA (read-only)" : "Owned"}
												</Badge>
											</TableCell>
										</TableRow>
									))}
								</TableBody>
							</Table>
						</CardContent>
					</Card>
					<Card>
						<CardHeader>
							<CardTitle>Printing</CardTitle>
							<CardDescription>Labels print through QZ Tray</CardDescription>
						</CardHeader>
						<CardContent className="text-sm text-muted-foreground">
							Not set up yet. Each packing PC needs QZ Tray and the katasync
							certificate.
						</CardContent>
					</Card>
				</div>
			</PageBody>
		</>
	);
}
