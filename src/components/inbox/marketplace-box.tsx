import {
	Archive,
	ChevronDown,
	Inbox,
	Mail,
	MailOpen,
	OctagonAlert,
	Star,
	Undo2,
} from "lucide-react";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { ChannelBadge } from "#/components/channel-badge";
import { Badge, EmptyState } from "#/components/page";
import { Button } from "#/components/ui/button";
import {
	ContextMenuItem,
	ContextMenuSeparator,
} from "#/components/ui/context-menu";
import { Tip } from "#/components/ui/tooltip";
import type { MarketCursor, MarketMailPage } from "#/inbox/market-mail";
import {
	FOLDER_NAMES,
	FOLDERS,
	type Folder,
	flagsOf,
	type Level,
	levelOf,
} from "#/inbox/rules";
import { optimism, optimistic } from "#/lib/optimism";
import { offerUndo } from "#/lib/undo";
import { cn } from "#/lib/utils";
import type { Market } from "#/markets/market";
import {
	type InboxCounts,
	listMarketMail,
	markMarketEmailImportant,
	moveMarketEmail,
	setMarketEmailDone,
	setMarketEmailRead,
} from "#/server/inbox";
import { MailOrders } from "./buyer-order";
import { folderIcon, type MarketView } from "./folders";
import { InboxFrame } from "./frame";
import { MailPane } from "./mail-pane";
import { MoveMenu, WhyChip } from "./sorted-by";
import { VoicemailMessage, voicemailRow } from "./voicemail";

// The marketplaces mailbox on the Inbox page: what Amazon, eBay, TikTok Shop,
// and Shopify email, sorted by the rules into folders, the ones needing
// someone marked important. Done clears one off its list; one in the wrong
// folder moves and stays moved, and says which rule put it there.

type Email = MarketMailPage["emails"][number];

const mail = optimistic<MarketMailPage>("market-emails");

// What happens to an email: done, back from done, to another folder, marked
// important, critical, or neither, or read or unread.
type Change =
	| { done: boolean }
	| { to: Folder }
	| { level: Level }
	| { read: boolean };
// What undoes one: null hands the folder or importance back to the rules,
// when they had decided it.
type Undo =
	| { done: boolean }
	| { to: Folder | null }
	| { level: Level | null }
	| { read: boolean };

const after = (e: Email, change: Change): Email =>
	"done" in change
		? {
				...e,
				doneAt: change.done ? new Date() : null,
				voicemail:
					!change.done && e.voicemail?.state === "dismissed"
						? {
								state: "review",
								reason: `Restored: ${e.voicemail.reason}`.slice(0, 500),
							}
						: e.voicemail,
			}
		: "to" in change
			? { ...e, folder: change.to, why: { ...e.why, folder: "by-hand" } }
			: "level" in change
				? {
						...e,
						...flagsOf(change.level),
						why: { ...e.why, important: "by-hand" },
					}
				: { ...e, readAt: change.read ? new Date() : null };

// Where an email is listed.
const belongs = (view: MarketView, e: Email) =>
	view === "done"
		? e.doneAt !== null
		: e.doneAt === null &&
			(view === "important"
				? e.important
				: view === "voicemails"
					? e.voicemail !== null
					: e.voicemail === null && e.folder === view);

// Moves the email's counts (unread open emails per folder, and important),
// and takes it off the list shown when it no longer belongs there.
function changed(key: string, view: MarketView, email: Email, change: Change) {
	const next = after(email, change);
	return mail.patch(key, (d) => {
		const c = { ...d.counts };
		const tally = (e: Email, by: 1 | -1) => {
			if (e.doneAt !== null || e.readAt !== null) return;
			if (e.voicemail) c.voicemails += by;
			else c[e.folder] += by;
			if (e.important) c.important += by;
			if (e.critical) c.critical += by;
		};
		tally(email, -1);
		tally(next, 1);
		return {
			...d,
			counts: c,
			emails: belongs(view, next)
				? d.emails.map((e) => (e.id === email.id ? next : e))
				: d.emails.filter((e) => e.id !== email.id),
		};
	});
}

type BoxProps = {
	view: MarketView;
	market: Market | null;
	page: MarketMailPage;
	counts: InboxCounts;
};

// Each folder and market has its own extra pages, so they start over when the
// list changes.
export function MarketplaceBox(props: BoxProps) {
	return <Listing key={`${props.view}|${props.market ?? "all"}`} {...props} />;
}

type Extra = { emails: Email[]; next: MarketCursor | null };

function Listing({ view, market, page, counts }: BoxProps) {
	const key = `${view}|${market ?? "all"}`;
	// Pages past the first, from "Show more". A change reloads only the first
	// page, so these stay until the list changes.
	const [extra, setExtra] = useState<Extra | null>(null);
	const [loading, setLoading] = useState(false);
	const shown = useMemo(() => {
		if (!extra) return page;
		const first = new Set(page.emails.map((e) => e.id));
		return {
			...page,
			emails: [...page.emails, ...extra.emails.filter((e) => !first.has(e.id))],
			next: extra.next,
		};
	}, [page, extra]);
	const d = mail.useData(key, shown);

	// Fetches the page after the last one shown, so none is skipped or repeated.
	async function showMore() {
		const after = shown.next;
		if (!after) return;
		setLoading(true);
		try {
			const later = await listMarketMail({ data: { view, market, after } });
			setExtra((prev) => ({
				emails: [...(prev?.emails ?? []), ...later.emails],
				next: later.next,
			}));
		} catch (error) {
			toast.error("Couldn't load more", {
				description: error instanceof Error ? error.message : String(error),
			});
		} finally {
			setLoading(false);
		}
	}

	// Makes a change, and offers to undo it with the opposite one; without
	// an undo, the row changing is all it says.
	async function make(
		email: Email,
		change: Change,
		said: string,
		undo?: { change: Undo; said: string },
	) {
		const send = (c: Undo) =>
			"done" in c
				? setMarketEmailDone({ data: { id: email.id, done: c.done } })
				: "to" in c
					? moveMarketEmail({ data: { id: email.id, folder: c.to } })
					: "read" in c
						? setMarketEmailRead({ data: { id: email.id, read: c.read } })
						: markMarketEmailImportant({
								data: { id: email.id, level: c.level },
							});
		const r = await optimism.change({
			label: said,
			patch: changed(key, view, email, change),
			send: () => send(change),
		});
		if (!r || !undo) return;
		offerUndo(said, {
			undo: async () => {
				const back = await optimism.change({
					label: "Putting it back",
					patch: [],
					send: () => send(undo.change),
				});
				return back ? undo.said : null;
			},
		});
	}

	const done = (e: Email, isDone: boolean) =>
		make(
			e,
			{ done: isDone },
			isDone
				? "Done"
				: `Back in ${e.voicemail ? "Voicemails" : FOLDER_NAMES[e.folder]}`,
			{
				change: { done: !isDone },
				said: "Put back",
			},
		);
	const move = (e: Email, to: Folder) =>
		make(e, { to }, `Moved to ${FOLDER_NAMES[to]}`, {
			change: { to: e.why.folder === "by-hand" ? e.folder : null },
			said: `Back in ${FOLDER_NAMES[e.folder]}`,
		});
	// Marks it this level, or back to normal when it already is.
	const mark = (e: Email, to: Exclude<Level, "normal">) => {
		const level = levelOf(e) === to ? "normal" : to;
		return make(
			e,
			{ level },
			level === "normal"
				? `Not ${to}`
				: to === "critical"
					? "Critical"
					: "Important",
			{
				change: {
					level: e.why.important === "by-hand" ? levelOf(e) : null,
				},
				said: "Put back",
			},
		);
	};
	const star = (e: Email) => mark(e, "important");
	const alarm = (e: Email) => mark(e, "critical");

	const read = (e: Email, isRead: boolean) =>
		make(e, { read: isRead }, isRead ? "Read" : "Unread");

	return (
		<InboxFrame
			folder={view}
			market={market}
			counts={{ ...counts, ...d.counts }}
		>
			{d.check?.error && (
				<p className="border-b bg-critical-surface px-4 py-2 font-medium text-critical-text">
					Can't read the mailbox: {d.check.error}
				</p>
			)}
			<MailPane
				box="marketplaces"
				emails={d.emails}
				fileUrl={(a) => `/api/market-email-attachments/${a.id}`}
				tagOf={(e) => <Tags email={e} view={view} market={market} />}
				unreadOf={(e) => e.readAt === null}
				criticalOf={(e) => e.critical}
				onShown={(e) => e.readAt === null && read(e, true)}
				actionsOf={(e) => (
					<Actions
						email={e}
						market={market}
						onDone={(isDone) => done(e, isDone)}
						onMove={(to) => move(e, to)}
						onStar={() => star(e)}
						onAlarm={() => alarm(e)}
						onRead={() => read(e, e.readAt === null)}
					/>
				)}
				aboutOf={(e) =>
					e.voicemail ? undefined : <MailOrders emailId={e.id} />
				}
				messageOf={(e) =>
					e.voicemail ? <VoicemailMessage email={e} /> : undefined
				}
				rowOf={voicemailRow}
				keysOf={(e) => ({
					e: () => done(e, e.doneAt === null),
					i: () => star(e),
					c: () => alarm(e),
					u: () => read(e, e.readAt === null),
				})}
				menuOf={(e) => (
					<>
						<ContextMenuItem
							shortcut="E"
							onSelect={() => done(e, e.doneAt === null)}
						>
							{e.doneAt === null ? <Archive /> : <Undo2 />}
							{e.doneAt === null
								? "Done"
								: `Back to ${e.voicemail ? "Voicemails" : FOLDER_NAMES[e.folder]}`}
						</ContextMenuItem>
						<ContextMenuItem
							shortcut="U"
							onSelect={() => read(e, e.readAt === null)}
						>
							{e.readAt === null ? <MailOpen /> : <Mail />}
							{e.readAt === null ? "Mark read" : "Mark unread"}
						</ContextMenuItem>
						<ContextMenuItem shortcut="I" onSelect={() => star(e)}>
							<Star
								className={cn(e.important && !e.critical && "fill-current")}
							/>
							{e.important && !e.critical ? "Not important" : "Important"}
						</ContextMenuItem>
						<ContextMenuItem shortcut="C" onSelect={() => alarm(e)}>
							<OctagonAlert
								className={cn(
									e.critical && "fill-critical-fill text-critical-icon",
								)}
							/>
							{e.critical ? "Not critical" : "Critical"}
						</ContextMenuItem>
						<ContextMenuSeparator />
						{!e.voicemail &&
							FOLDERS.filter((f) => f !== e.folder).map((f) => {
								const Icon = folderIcon(f);
								return (
									<ContextMenuItem key={f} onSelect={() => move(e, f)}>
										<Icon />
										Move to {FOLDER_NAMES[f]}
									</ContextMenuItem>
								);
							})}
					</>
				)}
				empty={<Empty view={view} connected={d.connected} />}
			/>
			{shown.next && (
				<div className="flex justify-center border-t p-2">
					<Button
						size="sm"
						variant="ghost"
						disabled={loading}
						onClick={showMore}
					>
						<ChevronDown className={cn(loading && "animate-pulse")} />
						Show more
					</Button>
				</div>
			)}
		</InboxFrame>
	);
}

// In a row: a star when important (a red octagon when critical), an Amazon
// buyer message left off its thread for an unverified sender, the folder
// where the list mixes them, and the marketplace where it isn't filtered to
// one.
function Tags({
	email: e,
	view,
	market,
}: {
	email: Email;
	view: MarketView;
	market: Market | null;
}) {
	return (
		<span className="flex items-center gap-1">
			{e.critical ? (
				<OctagonAlert
					aria-label="Critical"
					className="size-3.5 fill-critical-fill text-critical-icon"
				/>
			) : (
				e.important &&
				view !== "important" && (
					<Star className="size-3.5 fill-warning-fill text-warning-text" />
				)
			)}
			{e.unverified && <Badge tone="warning">Sender unverified</Badge>}
			{(view === "important" || view === "done") && (
				<Badge>{e.voicemail ? "Voicemail" : FOLDER_NAMES[e.folder]}</Badge>
			)}
			{market === null && e.market && (
				<ChannelBadge channel={e.market} salesChannel={null} compact />
			)}
		</span>
	);
}

function Actions({
	email: e,
	market,
	onDone,
	onMove,
	onStar,
	onAlarm,
	onRead,
}: {
	email: Email;
	market: Market | null;
	onDone: (done: boolean) => void;
	onMove: (to: Folder) => void;
	onStar: () => void;
	onAlarm: () => void;
	onRead: () => void;
}) {
	return (
		<>
			{/* The chips sit left; the buttons after them keep to the right. */}
			<span className="mr-auto flex min-w-0 items-center gap-1.5">
				{e.market && market === null && (
					<ChannelBadge channel={e.market} salesChannel={null} />
				)}
				{e.voicemail ? <Badge>Voicemail</Badge> : <WhyChip email={e} />}
				{e.unverified && (
					<Tip content={e.unverified}>
						<Badge tone="warning">Sender unverified</Badge>
					</Tip>
				)}
			</span>
			<Tip content={e.readAt === null ? "Mark read (U)" : "Mark unread (U)"}>
				<Button
					size="sm"
					variant="ghost"
					aria-label={e.readAt === null ? "Mark read" : "Mark unread"}
					onClick={onRead}
				>
					{e.readAt === null ? <MailOpen /> : <Mail />}
				</Button>
			</Tip>
			<Tip
				content={
					e.important && !e.critical ? "Not important (I)" : "Important (I)"
				}
			>
				<Button
					size="sm"
					variant="ghost"
					aria-pressed={e.important && !e.critical}
					aria-label="Important"
					onClick={onStar}
				>
					<Star
						key={String(e.important)}
						className={cn(
							"animate-in zoom-in-75",
							e.important && "fill-warning-fill text-warning-text",
						)}
					/>
				</Button>
			</Tip>
			<Tip content={e.critical ? "Not critical (C)" : "Critical (C)"}>
				<Button
					size="sm"
					variant="ghost"
					aria-pressed={e.critical}
					aria-label="Critical"
					onClick={onAlarm}
				>
					<OctagonAlert
						key={String(e.critical)}
						className={cn(
							"animate-in zoom-in-75",
							e.critical && "fill-critical-fill text-critical-icon",
						)}
					/>
				</Button>
			</Tip>
			{!e.voicemail && <MoveMenu from={e.folder} onMove={onMove} />}
			{e.doneAt === null ? (
				<Tip content="E">
					<Button size="sm" variant="secondary" onClick={() => onDone(true)}>
						<Archive />
						Done
					</Button>
				</Tip>
			) : (
				<Button size="sm" variant="secondary" onClick={() => onDone(false)}>
					<Undo2 />
					Back to {e.voicemail ? "Voicemails" : FOLDER_NAMES[e.folder]}
				</Button>
			)}
		</>
	);
}

function Empty({ view, connected }: { view: MarketView; connected: boolean }) {
	if (!connected)
		return (
			<EmptyState icon={Inbox} title="The marketplaces mailbox isn't connected">
				Set MARKETPLACE_INBOX to its address.
			</EmptyState>
		);
	return (
		<EmptyState
			icon={view === "important" ? Star : Inbox}
			title={
				view === "important"
					? "Nothing important"
					: view === "done"
						? "Nothing done yet"
						: view === "voicemails"
							? "No voicemails waiting"
							: `Nothing in ${FOLDER_NAMES[view]}`
			}
		/>
	);
}
