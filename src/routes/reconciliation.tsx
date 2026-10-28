import { createFileRoute } from "@tanstack/react-router";
import { Download, Landmark, Upload } from "lucide-react";
import { useState } from "react";
import { AccountBar } from "#/components/banking/account-bar";
import { ImportDialog } from "#/components/banking/import-dialog";
import { MatchPanel } from "#/components/banking/match-panel";
import { downloadRows, type RowFilter } from "#/components/banking/states";
import {
	BankRows,
	ImportsCard,
	PayoutsCard,
} from "#/components/banking/tables";
import { Card, EmptyState, Page } from "#/components/page";
import { ListCard, ListSkeleton } from "#/components/skeleton";
import { Button } from "#/components/ui/button";
import { getReconciliation } from "#/server/banking";

export const Route = createFileRoute("/reconciliation")({
	validateSearch: (search: Record<string, unknown>): { account?: number } => {
		const account = Number(search.account);
		return Number.isSafeInteger(account) && account > 0 ? { account } : {};
	},
	loaderDeps: ({ search }) => ({ account: search.account }),
	loader: ({ deps }) =>
		getReconciliation({
			data: deps.account === undefined ? {} : { accountId: deps.account },
		}),
	component: Reconciliation,
	pendingComponent: () => (
		<ListSkeleton title="Reconciliation">
			<ListCard rows={6} />
		</ListSkeleton>
	),
});

function Reconciliation() {
	const { accounts, account, rows, truncated, payouts, payoutsCut, imports } =
		Route.useLoaderData();
	const [importing, setImporting] = useState(false);
	const [openId, setOpenId] = useState<number | null>(null);
	const [chosen, setChosen] = useState<RowFilter | null>(null);
	const filter =
		chosen ??
		(rows.some((r) => r.state.kind === "needs-review")
			? "needs-review"
			: "unmatched");
	const open = rows.find((r) => r.id === openId) ?? null;

	return (
		<Page
			title="Reconciliation"
			width="wide"
			actions={
				account && (
					<>
						<Button
							variant="outline"
							disabled={rows.length === 0}
							onClick={() => downloadRows(account.name, account.currency, rows)}
						>
							<Download />
							CSV
						</Button>
						<Button onClick={() => setImporting(true)}>
							<Upload />
							Import CSV
						</Button>
					</>
				)
			}
		>
			<AccountBar accounts={accounts} current={account?.id ?? null} />
			{!account ? (
				<Card>
					<EmptyState icon={Landmark} title="No bank accounts yet">
						Add one with its currency, then import its statement CSV.
					</EmptyState>
				</Card>
			) : rows.length === 0 ? (
				<Card>
					<EmptyState
						icon={Upload}
						title={`Nothing imported to ${account.name}`}
					>
						<Button className="mt-2" onClick={() => setImporting(true)}>
							Import CSV
						</Button>
					</EmptyState>
				</Card>
			) : (
				<BankRows
					rows={rows}
					currency={account.currency}
					truncated={truncated}
					filter={filter}
					onFilter={setChosen}
					onOpen={(r) => setOpenId(r.id)}
				/>
			)}
			{account && (
				<PayoutsCard
					payouts={payouts}
					currency={account.currency}
					cut={payoutsCut}
				/>
			)}
			<ImportsCard imports={imports} />
			{account && (
				<>
					<ImportDialog
						account={account}
						open={importing}
						onOpenChange={setImporting}
					/>
					<MatchPanel
						row={open}
						currency={account.currency}
						onClose={() => setOpenId(null)}
					/>
				</>
			)}
		</Page>
	);
}
