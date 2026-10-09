import { createFileRoute } from "@tanstack/react-router";
import { ClipboardList } from "lucide-react";
import { Card, EmptyState, Page } from "#/components/page";

export const Route = createFileRoute("/purchasing")({ component: Purchasing });

function Purchasing() {
	return (
		<Page title="Purchase orders">
			<Card>
				<EmptyState icon={ClipboardList} title="Nothing to reorder yet">
					After a few weeks of orders, katasync suggests what to buy and drafts
					the purchase orders for you.
				</EmptyState>
			</Card>
		</Page>
	);
}
