import { createFileRoute, Link } from "@tanstack/react-router";
import { TabCount, tabClass } from "#/components/inbox/mail-pane";
import { MarketplaceBox } from "#/components/inbox/marketplace-box";
import { PurchasingBox } from "#/components/inbox/purchasing-box";
import { Card, Page } from "#/components/page";
import { ListSkeleton } from "#/components/skeleton";
import type { MarketView } from "#/inbox/market-mail";
import { MARKETS, type Market } from "#/markets/market";
import type { InboxView } from "#/purchasing/inbox/ingest";
import { inboxCounts, listMarketMail } from "#/server/inbox";
import { listPoEmails } from "#/server/purchasing";

// Every mailbox katasync reads, as one mail app: the marketplaces' notices,
// sorted so orders don't bury what needs someone, and suppliers' emails,
// filed on POs. Each keeps its own views.

type Search =
	| {
			box?: undefined;
			view?: Exclude<MarketView, "attention">;
			market?: Market;
	  }
	| { box: "purchasing"; view?: Exclude<InboxView, "to-file"> };

export const Route = createFileRoute("/inbox")({
	validateSearch: (s: Record<string, unknown>): Search => {
		if (s.box === "purchasing")
			return s.view === "set-aside" || s.view === "filed"
				? { box: "purchasing", view: s.view }
				: { box: "purchasing" };
		return {
			...(s.view === "orders" ||
			s.view === "returns" ||
			s.view === "updates" ||
			s.view === "done"
				? { view: s.view }
				: {}),
			...(MARKETS.includes(s.market as Market)
				? { market: s.market as Market }
				: {}),
		};
	},
	loaderDeps: ({ search }) =>
		search.box === "purchasing"
			? {
					box: "purchasing" as const,
					view: search.view ?? ("to-file" as const),
					market: null,
				}
			: {
					box: "marketplaces" as const,
					view: search.view ?? ("attention" as const),
					market: search.market ?? null,
				},
	loader: async ({ deps }) => {
		const counts = inboxCounts();
		return deps.box === "purchasing"
			? {
					box: deps.box,
					view: deps.view,
					page: await listPoEmails({ data: { view: deps.view } }),
					counts: await counts,
				}
			: {
					box: deps.box,
					view: deps.view,
					market: deps.market,
					page: await listMarketMail({
						data: { view: deps.view, market: deps.market },
					}),
					counts: await counts,
				};
	},
	component: InboxPage,
	pendingComponent: () => <ListSkeleton title="Inbox" width="wide" />,
});

function InboxPage() {
	const d = Route.useLoaderData();
	return (
		<Page
			title="Inbox"
			width="wide"
			actions={
				<div className="flex gap-1 rounded-lg border p-0.5">
					<Link
						to="/inbox"
						search={{}}
						className={tabClass(d.box === "marketplaces")}
					>
						Marketplaces
						<TabCount n={d.counts.attention} />
					</Link>
					<Link
						to="/inbox"
						search={{ box: "purchasing" }}
						className={tabClass(d.box === "purchasing")}
					>
						Purchasing
						<TabCount n={d.counts.toFile} />
					</Link>
				</div>
			}
		>
			<Card flush>
				{d.box === "purchasing" ? (
					<PurchasingBox view={d.view} page={d.page} />
				) : (
					<MarketplaceBox view={d.view} market={d.market} page={d.page} />
				)}
			</Card>
		</Page>
	);
}
