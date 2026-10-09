import { createFileRoute } from "@tanstack/react-router";
import { Truck } from "lucide-react";
import { EmptyState, PageBody, PageHeader } from "#/components/page";

export const Route = createFileRoute("/orders")({ component: Orders });

function Orders() {
	return (
		<>
			<PageHeader title="Orders" />
			<PageBody>
				<EmptyState icon={Truck} title="No orders coming in yet">
					Once Shopify is connected, every order to pack shows up here, from all
					four stores in one line.
				</EmptyState>
			</PageBody>
		</>
	);
}
