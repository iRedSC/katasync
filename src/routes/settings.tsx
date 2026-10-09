import { createFileRoute } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { Badge, Card, Page } from "#/components/page";
import { listLocations, listStores } from "#/server/catalog";

export const Route = createFileRoute("/settings")({
	loader: async () => {
		const [locations, stores] = await Promise.all([
			listLocations(),
			listStores(),
		]);
		return { locations, stores };
	},
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
		<Page title="Settings" narrow>
			<Card title="Sales channels" flush>
				<ul>
					{channels.map((c) => {
						const connected = stores.filter((s) => s.channel === c.id);
						return (
							<Item key={c.id} label={c.name}>
								{connected.length > 0 ? (
									<Badge tone="success">
										{connected.map((s) => s.name).join(", ")}
									</Badge>
								) : (
									<Badge>Not connected</Badge>
								)}
							</Item>
						);
					})}
				</ul>
			</Card>
			<Card title="Locations" flush>
				<ul>
					{locations.map((l) => (
						<Item key={l.id} label={l.name}>
							<span className="text-muted-foreground">
								{l.kind === "fba" ? "Amazon's warehouse" : "Ours"}
							</span>
						</Item>
					))}
				</ul>
			</Card>
			<Card title="Label printing">
				<p className="text-muted-foreground">
					Not set up yet. Each packing computer needs QZ Tray.
				</p>
			</Card>
		</Page>
	);
}

function Item({ label, children }: { label: string; children: ReactNode }) {
	return (
		<li className="flex items-center justify-between border-t px-4 py-3 first:border-t-0">
			<span className="font-medium">{label}</span>
			{children}
		</li>
	);
}
