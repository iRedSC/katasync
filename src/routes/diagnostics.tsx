import { createFileRoute, useRouter } from "@tanstack/react-router";
import { useState } from "react";
import { AgentChanges } from "#/components/diagnostics/agent-changes";
import { Sheet } from "#/components/diagnostics/connection-sheet";
import { Connections } from "#/components/diagnostics/connection-tiles";
import { diagnosticsData } from "#/components/diagnostics/diagnostics-data";
import { Problems } from "#/components/diagnostics/problem-list";
import { SyncStopped } from "#/components/diagnostics/sync-stopped";
import { Page } from "#/components/page";
import { FieldsCard, ListCard, ListSkeleton } from "#/components/skeleton";
import { Button } from "#/components/ui/button";
import type { CheckTarget } from "#/diagnostics/checks";
import { getDiagnostics } from "#/server/diagnostics";

export const Route = createFileRoute("/diagnostics")({
	loader: () => getDiagnostics(),
	component: DiagnosticsPage,
	pendingComponent: () => (
		<ListSkeleton title="Diagnostics">
			<ListCard rows={4} />
			<FieldsCard lines={4} />
		</ListSkeleton>
	),
});

function DiagnosticsPage() {
	const d = diagnosticsData.useData("all", Route.useLoaderData());
	const router = useRouter();
	const [sheet, setSheet] = useState<CheckTarget | null>(null);

	return (
		<Page
			title="Diagnostics"
			actions={
				<>
					{!d.worker.alive && (
						<SyncStopped lastStartedAt={d.worker.lastStartedAt} />
					)}
					<Button
						variant="outline"
						size="sm"
						onClick={() => router.invalidate()}
					>
						Refresh
					</Button>
				</>
			}
		>
			<Connections d={d} open={setSheet} />
			<Problems d={d} open={setSheet} />
			<AgentChanges calls={d.claude} />
			<Sheet d={d} target={sheet} onClose={() => setSheet(null)} />
		</Page>
	);
}
