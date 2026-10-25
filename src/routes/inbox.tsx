import { createFileRoute } from "@tanstack/react-router";
import { BuyerBox } from "#/components/inbox/buyer-box";
import {
	type InboxFolder,
	isFolder,
	isInboxFolder,
	isMarketView,
	isPurchasingView,
	purchasingFolderOf,
} from "#/components/inbox/folders";
import { InboxFrame, MarketFilter } from "#/components/inbox/frame";
import { MarketplaceBox } from "#/components/inbox/marketplace-box";
import { PrecedentsEditor } from "#/components/inbox/precedents-editor";
import { PurchasingBox } from "#/components/inbox/purchasing-box";
import { RulesEditor } from "#/components/inbox/rules-editor";
import { Page } from "#/components/page";
import { ListSkeleton } from "#/components/skeleton";
import type { Folder } from "#/inbox/rules";
import { MARKETS, type Market } from "#/markets/market";
import { getPrecedents } from "#/server/buyer-drafts";
import { listBuyerThreads } from "#/server/buyers";
import { getMailRules, inboxCounts, listMarketMail } from "#/server/inbox";
import { listPoEmails } from "#/server/purchasing";

// Every mailbox katasync reads, as one mail app: buyers' messages, answered
// in place; the marketplaces' notices,
// sorted by rules into folders so orders don't bury what needs someone, and
// suppliers' emails, filed on POs. The folders sit beside the list; the
// marketplace filter stays on top.

type Search = {
	folder?: Exclude<InboxFolder, "important">;
	market?: Market;
	// Buyers: the threads done with rather than open, and the one to open.
	threads?: "done";
	thread?: number;
	// Rules: the one open, or a new one started from an email's sender.
	rule?: number;
	sender?: string;
	to?: Folder;
};

// Links from before folders: ?box=purchasing&view=set-aside, ?view=orders;
// and from before Unfiled and Filed: ?folder=to-file.
function legacy(s: Record<string, unknown>): unknown {
	if (s.box === "purchasing") return purchasingFolderOf(s.view) ?? "unfiled";
	return s.view === "attention" ? "important" : s.view;
}

export const Route = createFileRoute("/inbox")({
	validateSearch: (s: Record<string, unknown>): Search => {
		const folder = purchasingFolderOf(s.folder) ?? s.folder ?? legacy(s);
		return {
			...(isInboxFolder(folder) && folder !== "important" ? { folder } : {}),
			...(MARKETS.includes(s.market as Market)
				? { market: s.market as Market }
				: {}),
			...(folder === "buyers" && s.threads === "done"
				? { threads: "done" as const }
				: {}),
			...(folder === "buyers" && typeof s.thread === "number"
				? { thread: s.thread }
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
		threads: search.threads ?? ("open" as const),
	}),
	loader: async ({ deps: { folder, market, threads } }) => {
		const counts = inboxCounts({ data: { market } });
		if (folder === "precedents")
			return {
				kind: "precedents" as const,
				page: await getPrecedents(),
				counts: await counts,
			};
		if (folder === "buyers")
			return {
				kind: "buyers" as const,
				view: threads,
				page: await listBuyerThreads({ data: { view: threads, market } }),
				counts: await counts,
			};
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
				page: await listPoEmails({ data: { view: folder } }),
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
	const { market, rule, sender, to, thread } = Route.useSearch();
	return (
		<Page
			title="Inbox"
			width="wide"
			actions={
				(d.kind === "marketplaces" || d.kind === "buyers") && (
					<MarketFilter
						folder={d.kind === "buyers" ? "buyers" : d.folder}
						market={market ?? null}
						check={d.kind === "buyers" ? undefined : d.page.check}
					/>
				)
			}
		>
			{d.kind === "buyers" ? (
				<BuyerBox
					view={d.view}
					market={market ?? null}
					page={d.page}
					counts={d.counts}
					open={thread ?? null}
				/>
			) : d.kind === "precedents" ? (
				<InboxFrame
					folder="precedents"
					market={market ?? null}
					counts={d.counts}
				>
					<PrecedentsEditor page={d.page} />
				</InboxFrame>
			) : d.kind === "marketplaces" ? (
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
