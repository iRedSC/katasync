import { Link, useRouter } from "@tanstack/react-router";
import { RefreshCw } from "lucide-react";
import { type ReactNode, useState } from "react";
import { toast } from "sonner";
import { ChannelBadge } from "#/components/channel-badge";
import { Card } from "#/components/page";
import { Button } from "#/components/ui/button";
import { Tip } from "#/components/ui/tooltip";
import type { MarketMailPage } from "#/inbox/market-mail";
import { formatDateTime } from "#/lib/format";
import { cn } from "#/lib/utils";
import { MARKETS, type Market } from "#/markets/market";
import { checkMarketMailNow, type InboxCounts } from "#/server/inbox";
import {
	BUYERS,
	type InboxFolder,
	MARKET_FOLDERS,
	PRECEDENTS,
	PURCHASING_FOLDERS,
	RULES,
} from "./folders";
import { tabClass } from "./mail-pane";

// The Inbox page's frame: every folder down the side, each with what waits
// in it, and the open folder beside them. On a phone the folders run across
// the top instead.

// Where a folder's link goes; the market filter stays as it is.
export const folderSearch = (folder: InboxFolder, market: Market | null) => ({
	...(folder === "important" ? {} : { folder }),
	...(market ? { market } : {}),
});

const waiting = (folder: InboxFolder, c: InboxCounts): number | null =>
	folder === "to-file"
		? c.toFile
		: folder === "set-aside"
			? c.setAside
			: folder in c
				? c[folder as keyof InboxCounts]
				: null;

export function InboxFrame({
	folder,
	market,
	counts,
	children,
}: {
	folder: InboxFolder;
	market: Market | null;
	counts: InboxCounts;
	children: ReactNode;
}) {
	const item = (e: (typeof MARKET_FOLDERS)[number]) => {
		// Important counts its critical emails apart, in red, and the rest after.
		const critical = e.folder === "important" ? counts.critical : 0;
		const n = (waiting(e.folder, counts) ?? 0) - critical;
		const active = e.folder === folder;
		return (
			<Link
				key={e.folder}
				to="/inbox"
				search={folderSearch(e.folder, market)}
				className={cn(
					"flex h-8 shrink-0 items-center gap-2 rounded-lg px-2.5 font-medium",
					active
						? "bg-surface-strong text-foreground"
						: "text-muted-foreground hover:bg-surface hover:text-foreground",
				)}
			>
				<e.icon
					className={cn(
						"size-4 shrink-0",
						e.folder === "important" && critical
							? "fill-critical-icon text-critical-icon"
							: e.folder === "important" && n
								? "fill-warning-fill text-warning-text"
								: e.folder === "buyers" && n
									? "text-critical-text"
									: "",
					)}
				/>
				<span className="flex-1 truncate">{e.name}</span>
				{critical > 0 && (
					<span
						key={`c${critical}`}
						className="rounded-md bg-critical-icon px-1.5 text-xs font-semibold text-white tabular-nums animate-in fade-in-0 zoom-in-90"
					>
						{critical}
					</span>
				)}
				{n ? (
					<span
						key={n}
						className="tabular-nums text-muted-foreground animate-in fade-in-0 zoom-in-90"
					>
						{n}
					</span>
				) : null}
			</Link>
		);
	};
	return (
		<Card flush>
			<div className="grid md:grid-cols-[12rem_minmax(0,1fr)]">
				<nav className="flex gap-0.5 overflow-x-auto border-b p-2 md:flex-col md:overflow-visible md:border-r md:border-b-0">
					{item(BUYERS)}
					<Group>Marketplaces</Group>
					{MARKET_FOLDERS.map(item)}
					<Group>Purchasing</Group>
					{PURCHASING_FOLDERS.map(item)}
					{/* What sorts the mail and what the reply agent follows. */}
					<div className="flex gap-0.5 md:mt-auto md:flex-col md:border-t md:pt-2">
						{item(PRECEDENTS)}
						{item(RULES)}
					</div>
				</nav>
				<div className="min-w-0">{children}</div>
			</div>
		</Card>
	);
}

function Group({ children }: { children: ReactNode }) {
	return (
		<span className="hidden px-2.5 pt-3 pb-1 text-xs font-semibold text-muted-foreground md:block">
			{children}
		</span>
	);
}

// Which marketplace's mail shows, and reading the mailbox now (left out
// without a check: Buyers reads its own sources).
export function MarketFilter({
	folder,
	market,
	check,
}: {
	folder: InboxFolder;
	market: Market | null;
	check?: MarketMailPage["check"];
}) {
	return (
		<>
			<div className="flex gap-1 rounded-lg border p-0.5">
				<Link
					to="/inbox"
					search={folderSearch(folder, null)}
					className={tabClass(market === null)}
				>
					All
				</Link>
				{MARKETS.map((m) => (
					<Link
						key={m}
						to="/inbox"
						search={folderSearch(folder, m)}
						className={tabClass(market === m)}
					>
						<ChannelBadge channel={m} salesChannel={null} compact />
					</Link>
				))}
			</div>
			{check !== undefined && <CheckNow check={check} />}
		</>
	);
}

// Reads the mailbox now; the list reloads with anything new.
function CheckNow({ check }: { check: MarketMailPage["check"] }) {
	const router = useRouter();
	const [busy, setBusy] = useState(false);
	return (
		<Tip
			content={
				check?.checkedAt
					? `Read ${formatDateTime(check.checkedAt)}`
					: "Not read yet"
			}
		>
			<Button
				size="sm"
				variant="ghost"
				disabled={busy}
				aria-label="Check for new email"
				onClick={async () => {
					setBusy(true);
					try {
						const r = await checkMarketMailNow();
						if ("error" in r && r.error)
							// Some mail read and some didn't is not the same as none.
							toast.error(
								"read" in r && r.read > 0
									? "Some emails didn't read"
									: "Couldn't read the mailbox",
								{ description: r.error },
							);
						else if ("skipped" in r && r.skipped)
							toast.error("The mailbox isn't set up", {
								description: r.skipped,
							});
						await router.invalidate();
					} finally {
						setBusy(false);
					}
				}}
			>
				<RefreshCw className={cn(busy && "animate-spin")} />
			</Button>
		</Tip>
	);
}
