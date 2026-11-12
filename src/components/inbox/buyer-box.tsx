import { useRouter } from "@tanstack/react-router";
import { CheckCheck, ExternalLink, RefreshCw } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import type { MessageMarket } from "#/buyers/threads";
import { ChannelBadge } from "#/components/channel-badge";
import { Button } from "#/components/ui/button";
import { Tip } from "#/components/ui/tooltip";
import { channelName, formatCount, formatDateTime } from "#/lib/format";
import { offerUndo } from "#/lib/undo";
import { cn } from "#/lib/utils";
import {
	type BuyerMarket,
	checkBuyerMessagesNow,
	clearBuyerMarket,
	unclearBuyerThreads,
} from "#/server/buyers";
import type { InboxCounts } from "#/server/inbox";
import { InboxFrame } from "./frame";

// The Buyers folder: how many buyers wait on a reply in each marketplace.
// They're read and answered on the marketplace itself, so each row opens
// its messages there. A source that isn't being read says so on its row,
// since its count would otherwise look like no one's waiting. Clear takes
// what needs no answer (a "thanks") out of the count, with undo.

const MESSAGES_PAGE: Record<MessageMarket, string> = {
	amazon: "https://sellercentral.amazon.com/messaging/inbox",
	ebay: "https://mesg.ebay.com/mesgweb/ViewMessages/0",
	tiktok: "https://seller-us.tiktok.com/chat/inbox/current",
};

export function BuyerBox({
	markets,
	counts,
}: {
	markets: BuyerMarket[];
	counts: InboxCounts;
}) {
	return (
		<InboxFrame
			folder="buyers"
			market={null}
			counts={{
				...counts,
				buyers: markets.reduce((n, m) => n + m.waiting, 0),
			}}
		>
			<div className="flex justify-end border-b px-3 py-2">
				<CheckNow />
			</div>
			<ul className="divide-y">
				{markets.map((m) => (
					<MarketRow key={m.market} market={m} />
				))}
			</ul>
		</InboxFrame>
	);
}

function MarketRow({ market: m }: { market: BuyerMarket }) {
	const router = useRouter();
	// Zero at once on Clear, until the reload says what's left.
	const [cleared, setCleared] = useState(false);
	const waiting = cleared ? 0 : m.waiting;

	async function clear() {
		setCleared(true);
		try {
			const { cleared: ids } = await clearBuyerMarket({
				data: { market: m.market },
			});
			await router.invalidate();
			if (ids.length > 0)
				offerUndo(`Cleared ${formatCount(ids.length)}`, {
					undo: async () => {
						await unclearBuyerThreads({ data: { ids } });
						await router.invalidate();
						return "Put back";
					},
				});
		} catch (error) {
			toast.error("Couldn't clear", {
				description: error instanceof Error ? error.message : String(error),
			});
		} finally {
			setCleared(false);
		}
	}

	return (
		<li className="flex items-center hover:bg-surface">
			<a
				href={MESSAGES_PAGE[m.market]}
				aria-label={`${channelName(m.market)}: ${waiting} unanswered`}
				target="_blank"
				rel="noreferrer"
				className="group flex min-w-0 flex-1 items-center gap-3 py-4 pl-4"
			>
				<ChannelBadge channel={m.market} salesChannel={null} />
				{m.source.kind !== "read" && (
					<Tip
						content={
							m.source.kind === "failed"
								? m.source.error
								: m.source.checkedAt
									? `Last read ${formatDateTime(m.source.checkedAt)}`
									: "Never read"
						}
					>
						<span className="flex items-center gap-1.5 text-sm font-medium text-critical-text">
							<span className="size-2 animate-pulse rounded-full bg-critical-text" />
							{m.source.kind === "failed" ? "Not read" : "Behind"}
						</span>
					</Tip>
				)}
				<span
					key={waiting}
					className={cn(
						"ml-auto text-2xl tabular-nums animate-in fade-in-0 zoom-in-90",
						waiting > 0
							? "font-semibold text-critical-text"
							: "text-muted-foreground",
					)}
				>
					{waiting}
				</span>
				<ExternalLink className="size-4 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100" />
			</a>
			{/* Kept in place at zero, so the count doesn't shift. */}
			<span className="px-2">
				<Tip content="Clear: none of these need an answer">
					<Button
						size="sm"
						variant="ghost"
						aria-label={`Clear ${channelName(m.market)}`}
						className={cn(waiting === 0 && "invisible")}
						onClick={clear}
					>
						<CheckCheck />
					</Button>
				</Tip>
			</span>
		</li>
	);
}

// Reads every marketplace now; the counts reload with what's new.
function CheckNow() {
	const router = useRouter();
	const [busy, setBusy] = useState(false);
	return (
		<Tip content="Check for new messages">
			<Button
				size="sm"
				variant="ghost"
				disabled={busy}
				aria-label="Check for new messages"
				onClick={async () => {
					setBusy(true);
					try {
						await checkBuyerMessagesNow();
					} catch (error) {
						toast.error("Couldn't check", {
							description:
								error instanceof Error ? error.message : String(error),
						});
					} finally {
						await router.invalidate();
						setBusy(false);
					}
				}}
			>
				<RefreshCw className={cn(busy && "animate-spin")} />
			</Button>
		</Tip>
	);
}
