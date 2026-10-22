import { createFileRoute } from "@tanstack/react-router";
import {
	type InboxFolder,
	isFolder,
	isInboxFolder,
	isMarketView,
	isPurchasingView,
	purchasingView,
} from "#/components/inbox/folders";
import { InboxFrame, MarketFilter } from "#/components/inbox/frame";
import { MarketplaceBox } from "#/components/inbox/marketplace-box";
import { PurchasingBox } from "#/components/inbox/purchasing-box";
import { RulesEditor } from "#/components/inbox/rules-editor";
import { Page } from "#/components/page";
import { ListSkeleton } from "#/components/skeleton";
import type { Folder } from "#/inbox/rules";
import { MARKETS, type Market } from "#/markets/market";
import { getMailRules, inboxCounts, listMarketMail } from "#/server/inbox";
import { listPoEmails } from "#/server/purchasing";

// Every mailbox katasync reads, as one mail app: the marketplaces' notices,
// sorted by rules into folders so orders don't bury what needs someone, and
// suppliers' emails, filed on POs. The folders sit beside the list; the
// marketplace filter stays on top.

type Search = {
	folder?: Exclude<InboxFolder, "important">;
	market?: Market;
	// Rules: the one open, or a new one started from an email's sender.
	rule?: number;
	sender?: string;
	to?: Folder;
};

// Links from before folders: ?box=purchasing&view=set-aside, ?view=orders.
function legacy(s: Record<string, unknown>): unknown {
	if (s.box === "purchasing")
		return s.view === "filed"
			? "on-po"
			: s.view === "set-aside"
				? "set-aside"
				: "to-file";
	return s.view === "attention" ? "important" : s.view;
}

export const Route = createFileRoute("/inbox")({
	validateSearch: (s: Record<string, unknown>): Search => {
		const folder = s.folder ?? legacy(s);
		return {
			...(isInboxFolder(folder) && folder !== "important" ? { folder } : {}),
			...(MARKETS.includes(s.market as Market)
				? { market: s.market as Market }
				: {}),
			...(folder === "rules" && typeof s.rule === "number"
				? { rule: s.rule }
				: {}),
			...(folder === "rules" && typeof s.sender === "string"
				? { sender: s.sender }
				: {}),
			...(folder === "rules" && isFolder(s.to) ? { to: s.to } : {}),
		};
	},
	loaderDeps: ({ search }) => ({
		folder: search.folder ?? ("important" as const),
		market: search.market ?? null,
	}),
	loader: async ({ deps: { folder, market } }) => {
		const counts = inboxCounts({ data: { market } });
		if (folder === "rules")
			return {
				kind: "rules" as const,
				rules: await getMailRules(),
				counts: await counts,
			};
		if (isPurchasingView(folder))
			return {
				kind: "purchasing" as const,
				folder,
				page: await listPoEmails({ data: { view: purchasingView(folder) } }),
				counts: await counts,
			};
		if (!isMarketView(folder)) throw new Error(`No folder ${folder}`);
		return {
			kind: "marketplaces" as const,
			folder,
			page: await listMarketMail({ data: { view: folder, market } }),
			counts: await counts,
		};
	},
	component: InboxPage,
	pendingComponent: () => <ListSkeleton title="Inbox" width="wide" />,
});

function InboxPage() {
	const d = Route.useLoaderData();
	const { market, rule, sender, to } = Route.useSearch();
	return (
		<Page
			title="Inbox"
			width="wide"
			actions={
				d.kind === "marketplaces" && (
					<MarketFilter
						folder={d.folder}
						market={market ?? null}
						check={d.page.check}
					/>
				)
			}
		>
			{d.kind === "marketplaces" ? (
				<MarketplaceBox
					view={d.folder}
					market={market ?? null}
					page={d.page}
					counts={d.counts}
				/>
			) : d.kind === "purchasing" ? (
				<PurchasingBox view={d.folder} page={d.page} counts={d.counts} />
			) : (
				<InboxFrame folder="rules" market={market ?? null} counts={d.counts}>
					<RulesEditor
						rules={d.rules}
						open={rule ?? null}
						draft={sender ? { sender, folder: to ?? null } : null}
					/>
				</InboxFrame>
			)}
		</Page>
	);
}
