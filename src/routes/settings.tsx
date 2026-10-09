import { createFileRoute } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { PageBody, PageHeader, Section, StatusDot } from "#/components/page";
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
			<PageBody className="max-w-2xl">
				<Section title="Stores">
					<ul>
						{channels.map((c) => {
							const connected = stores.filter((s) => s.channel === c.id);
							return (
								<Item key={c.id} label={c.name}>
									{connected.length > 0 ? (
										<StatusDot tone="good">
											{connected.map((s) => s.name).join(", ")}
										</StatusDot>
									) : (
										<span className="text-sm text-muted-foreground">
											Not connected
										</span>
									)}
								</Item>
							);
						})}
					</ul>
				</Section>
				<Section title="Where stock lives">
					<ul>
						{locations.map((l) => (
							<Item key={l.id} label={l.name}>
								<span className="text-sm text-muted-foreground">
									{l.kind === "fba" ? "Amazon's warehouse" : "Ours"}
								</span>
							</Item>
						))}
					</ul>
				</Section>
				<Section title="Label printing">
					<p className="text-sm text-muted-foreground">
						Not set up yet. Each packing computer needs QZ Tray.
					</p>
				</Section>
			</PageBody>
		</>
	);
}

function Item({ label, children }: { label: string; children: ReactNode }) {
	return (
		<li className="flex items-center justify-between border-b py-3 last:border-0">
			<span className="font-medium">{label}</span>
			{children}
		</li>
	);
}
