import { Link, useRouter } from "@tanstack/react-router";
import { ArrowLeft, MessagesSquare, RefreshCw } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import type { BuyerThread, MessageSource } from "#/buyers/threads";
import { ChannelBadge } from "#/components/channel-badge";
import { EmptyState } from "#/components/page";
import { Button } from "#/components/ui/button";
import { Tip } from "#/components/ui/tooltip";
import { channelName, formatDateTime, formatTime } from "#/lib/format";
import { useHotkeys } from "#/lib/hotkeys";
import { offerUndo } from "#/lib/undo";
import { cn } from "#/lib/utils";
import type { Market } from "#/markets/market";
import {
	type BuyerThreadsPage,
	checkBuyerMessagesNow,
	setBuyerThreadDone,
} from "#/server/buyers";
import type { InboxCounts } from "#/server/inbox";
import { BuyerConversation } from "./buyer-thread";
import { DueChip } from "./due-chip";
import { folderSearch, InboxFrame } from "./frame";
import { tabClass } from "./mail-pane";

// The Buyers folder: every conversation with a buyer, those waiting on us
// first, soonest due first, each answered in place. Above them, whether
// every source of messages is being read, since a quiet list must mean no
// messages, not a source that stopped.

export function BuyerBox({
	view,
	market,
	page,
	counts,
	open = null,
}: {
	view: "open" | "done";
	market: Market | null;
	page: BuyerThreadsPage;
	counts: InboxCounts;
	// The thread a link opened (an order's Email buyer).
	open?: number | null;
}) {
	const router = useRouter();
	const [hidden, setHidden] = useState<Set<number>>(new Set());
	const threads = page.threads.filter((t) => !hidden.has(t.id));
	const [selectedId, setSelectedId] = useState<number | null>(open);
	const [reading, setReading] = useState(open !== null);
	const selected =
		threads.find((t) => t.id === selectedId) ?? threads[0] ?? null;

	// Replies still on their way settle on the server; look again until
	// they have.
	const inFlight = page.threads.some((t) =>
		t.messages.some((m) => m.status === "sending" || m.status === "sent"),
	);
	useEffect(() => {
		if (!inFlight) return;
		const timer = setInterval(() => router.invalidate(), 15_000);
		return () => clearInterval(timer);
	}, [inFlight, router]);

	const show = (id: number) =>
		setHidden((h) => {
			const next = new Set(h);
			next.delete(id);
			return next;
		});
	async function done(t: BuyerThread, isDone: boolean) {
		setHidden((h) => new Set(h).add(t.id));
		try {
			await setBuyerThreadDone({ data: { id: t.id, done: isDone } });
		} catch (error) {
			show(t.id);
			toast.error("Couldn't move it", {
				description: error instanceof Error ? error.message : String(error),
			});
			return;
		}
		offerUndo(isDone ? "Done" : "Reopened", {
			undo: async () => {
				await setBuyerThreadDone({ data: { id: t.id, done: !isDone } });
				await router.invalidate();
				show(t.id);
				return "Put back";
			},
		});
		await router.invalidate();
	}

	useHotkeys({
		j: () => step(1),
		k: () => step(-1),
		...(selected ? { e: () => done(selected, view === "open") } : {}),
	});
	function step(by: number) {
		const i = threads.findIndex((t) => t.id === selected?.id);
		const next = threads[i + by];
		if (next) setSelectedId(next.id);
	}

	return (
		<InboxFrame
			folder="buyers"
			market={market}
			counts={{
				...counts,
				buyers: page.threads.filter((t) => t.waiting).length,
			}}
		>
			<div className="flex flex-wrap items-center gap-2 border-b px-3 py-2">
				<div className="flex gap-1 rounded-lg border p-0.5">
					{(["open", "done"] as const).map((v) => (
						<Link
							key={v}
							to="/inbox"
							search={{
								...folderSearch("buyers", market),
								...(v === "done" ? { threads: "done" as const } : {}),
							}}
							className={tabClass(view === v)}
						>
							{v === "open" ? "Open" : "Done"}
						</Link>
					))}
				</div>
				<Sources sources={page.sources} />
			</div>
			{selected === null ? (
				<EmptyState
					icon={MessagesSquare}
					title={view === "open" ? "No one's waiting" : "Nothing done yet"}
				/>
			) : (
				<div className="grid md:min-h-0 md:flex-1 md:grid-cols-[22rem_minmax(0,1fr)]">
					<ul
						className={cn(
							"min-h-0 divide-y overflow-y-auto md:border-r",
							reading && "hidden md:block",
						)}
					>
						{threads.map((t) => (
							<ThreadRow
								key={t.id}
								thread={t}
								market={market}
								selected={t.id === selected.id}
								onOpen={() => {
									setSelectedId(t.id);
									setReading(true);
								}}
							/>
						))}
					</ul>
					<div
						className={cn(
							"flex min-h-0 flex-col",
							!reading && "hidden md:flex",
						)}
					>
						<button
							type="button"
							onClick={() => setReading(false)}
							className="flex items-center gap-1 px-4 pt-3 text-muted-foreground md:hidden"
						>
							<ArrowLeft className="size-4" />
							Buyers
						</button>
						<BuyerConversation
							key={selected.id}
							thread={selected}
							ai={page.ai}
							onDone={(isDone) => done(selected, isDone)}
						/>
					</div>
				</div>
			)}
		</InboxFrame>
	);
}

// A message of only pictures or files, in a few words.
const mediaLine = (media: { kind: string }[]) => {
	const photos = media.filter((m) => m.kind === "IMAGE").length;
	if (photos === media.length && photos > 0)
		return photos === 1 ? "Photo" : `${photos} photos`;
	return media.length === 1 ? "File" : `${media.length} files`;
};

function ThreadRow({
	thread: t,
	market,
	selected,
	onOpen,
}: {
	thread: BuyerThread;
	market: Market | null;
	selected: boolean;
	onOpen: () => void;
}) {
	const last = t.messages.at(-1);
	return (
		<li>
			<button
				type="button"
				onClick={onOpen}
				className={cn(
					"flex w-full flex-col gap-0.5 px-4 py-2.5 text-left",
					selected ? "bg-surface-strong" : "hover:bg-surface",
				)}
			>
				<span className="flex items-center gap-1.5">
					<span
						className={cn(
							"min-w-0 flex-1 truncate",
							t.waiting ? "font-semibold" : "text-muted-foreground",
						)}
					>
						{t.buyerName ?? "Buyer"}
					</span>
					{market === null && (
						<ChannelBadge channel={t.market} salesChannel={null} compact />
					)}
					{t.waiting ? (
						<DueChip due={t.waiting.due} now={Date.now()} />
					) : (
						last && (
							<span className="text-xs text-muted-foreground tabular-nums">
								{formatTime(last.at)}
							</span>
						)
					)}
				</span>
				<span className="truncate text-sm text-muted-foreground">
					{last && !last.fromBuyer && "You: "}
					{last ? last.body || mediaLine(last.media) : t.subject}
				</span>
			</button>
		</li>
	);
}

// A dot per source: green while it's read on time, red when it isn't, with
// why. The list is only complete while every dot is green.
function Sources({ sources }: { sources: MessageSource[] }) {
	const router = useRouter();
	const [busy, setBusy] = useState(false);
	return (
		<span className="ml-auto flex items-center gap-3">
			{sources.map((s) => {
				const broken = Boolean(s.error) || s.behind;
				return (
					<Tip
						key={s.market}
						content={
							s.error ??
							(s.checkedAt
								? `Read ${formatDateTime(s.checkedAt)}`
								: "Never read")
						}
					>
						<span className="flex items-center gap-1.5 text-sm">
							<span
								className={cn(
									"size-2 rounded-full",
									broken ? "animate-pulse bg-critical-text" : "bg-success-text",
								)}
							/>
							<span className={cn(broken && "font-medium text-critical-text")}>
								{channelName(s.market)}
								{broken && (s.error ? " not read" : " behind")}
							</span>
						</span>
					</Tip>
				);
			})}
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
		</span>
	);
}
