import { createFileRoute } from "@tanstack/react-router";
import { ClipboardList } from "lucide-react";
import { EmptyState, PageBody, PageHeader } from "#/components/page";

export const Route = createFileRoute("/purchasing")({ component: Purchasing });

function Purchasing() {
	return (
		<>
			<PageHeader title="Purchasing" />
			<PageBody>
				<EmptyState icon={ClipboardList} title="Nothing to reorder yet">
					After a few weeks of orders, katasync suggests what to buy and drafts
					the purchase orders for you.
				</EmptyState>
			</PageBody>
		</>
	);
}
