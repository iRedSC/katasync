import { createFileRoute } from "@tanstack/react-router";
import { Truck } from "lucide-react";
import { Card, EmptyState, Page } from "#/components/page";

export const Route = createFileRoute("/orders")({ component: Orders });

function Orders() {
	return (
		<Page title="Orders">
			<Card>
				<EmptyState icon={Truck} title="No orders coming in yet">
					Once Shopify is connected, every order to pack shows up here, from all
					four stores in one list.
				</EmptyState>
			</Card>
		</Page>
	);
}
