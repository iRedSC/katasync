import { createFileRoute } from "@tanstack/react-router";
import { ClipboardList, Plus, TrendingUp } from "lucide-react";
import { EmptyState, PageBody, PageHeader } from "#/components/page";
import { Button } from "#/components/ui/button";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "#/components/ui/card";

export const Route = createFileRoute("/purchasing")({ component: Purchasing });

function Purchasing() {
	return (
		<>
			<PageHeader
				title="Purchase orders"
				actions={
					<Button size="sm" disabled>
						<Plus />
						New PO
					</Button>
				}
			/>
			<PageBody>
				<div className="grid gap-4 lg:grid-cols-2">
					<Card>
						<CardHeader>
							<CardTitle>Suggested reorders</CardTitle>
							<CardDescription>
								From sales velocity, lead time, and what's on order
							</CardDescription>
						</CardHeader>
						<CardContent>
							<EmptyState icon={TrendingUp} title="Needs sales history">
								Suggestions start once order intake has recorded a few weeks of
								sales. Bundle sales count toward their components.
							</EmptyState>
						</CardContent>
					</Card>
					<Card>
						<CardHeader>
							<CardTitle>Open POs</CardTitle>
							<CardDescription>
								Draft, sent, and partly received
							</CardDescription>
						</CardHeader>
						<CardContent>
							<EmptyState icon={ClipboardList} title="No purchase orders yet">
								POs get emailed to suppliers as PDFs, and receiving them by scan
								adds the stock.
							</EmptyState>
						</CardContent>
					</Card>
				</div>
			</PageBody>
		</>
	);
}
