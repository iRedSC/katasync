import { createFileRoute } from "@tanstack/react-router";
import { Printer, Tag, Truck } from "lucide-react";
import { EmptyState, PageBody, PageHeader } from "#/components/page";
import { Button } from "#/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "#/components/ui/tabs";

export const Route = createFileRoute("/orders")({ component: Orders });

const stages = [
	{ value: "pick", label: "To pick" },
	{ value: "pack", label: "To pack" },
	{ value: "shipped", label: "Shipped" },
];

function Orders() {
	return (
		<>
			<PageHeader
				title="Orders"
				description="One queue for Shopify, Amazon, eBay, and TikTok Shop"
				actions={
					<>
						<Button size="sm" variant="outline" disabled>
							<Tag />
							Buy labels
						</Button>
						<Button size="sm" variant="outline" disabled>
							<Printer />
							Print
						</Button>
					</>
				}
			/>
			<PageBody>
				<Tabs defaultValue="pick">
					<TabsList>
						{stages.map((s) => (
							<TabsTrigger key={s.value} value={s.value}>
								{s.label}
							</TabsTrigger>
						))}
					</TabsList>
					{stages.map((s) => (
						<TabsContent key={s.value} value={s.value} className="pt-4">
							<EmptyState icon={Truck} title="Order intake isn't connected yet">
								Shopify comes first. Orders get picked, packed, labeled through
								the marketplace or Shippo, printed with QZ Tray, and tracking
								goes back to the channel.
							</EmptyState>
						</TabsContent>
					))}
				</Tabs>
			</PageBody>
		</>
	);
}
