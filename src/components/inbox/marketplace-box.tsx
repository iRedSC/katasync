import { Archive, Inbox, Mail, MailOpen, Star, Undo2 } from "lucide-react";
import { ChannelBadge } from "#/components/channel-badge";
import { Badge, EmptyState } from "#/components/page";
import { Button } from "#/components/ui/button";
import {
	ContextMenuItem,
	ContextMenuSeparator,
} from "#/components/ui/context-menu";
import { Tip } from "#/components/ui/tooltip";
import type { MarketMailPage } from "#/inbox/market-mail";
import { FOLDER_NAMES, FOLDERS, type Folder } from "#/inbox/rules";
import { optimism, optimistic } from "#/lib/optimism";
import { offerUndo } from "#/lib/undo";
import { cn } from "#/lib/utils";
import type { Market } from "#/markets/market";
import {
	type InboxCounts,
	markMarketEmailImportant,
	moveMarketEmail,
	setMarketEmailDone,
	setMarketEmailRead,
} from "#/server/inbox";
import { folderIcon, type MarketView } from "./folders";
import { InboxFrame } from "./frame";
import { MailPane } from "./mail-pane";
import { MoveMenu, WhyChip } from "./sorted-by";

// The marketplaces mailbox on the Inbox page: what Amazon, eBay, TikTok Shop,
// and Shopify email, sorted by the rules into folders, the ones needing
// someone marked important. Done clears one off its list; one in the wrong
// folder moves and stays moved, and says which rule put it there.

type Email = MarketMailPage["emails"][number];

const mail = optimistic<MarketMailPage>("market-emails");

// What happens to an email: done, back from done, to another folder, marked
// important or not, or read or unread.
type Change =
	| { done: boolean }
	| { to: Folder }
	| { important: boolean }
	| { read: boolean };
// What undoes one: null hands the folder or importance back to the rules,
// when they had decided it.
type Undo =
	| { done: boolean }
	| { to: Folder | null }
	| { important: boolean | null }
	| { read: boolean };

const after = (e: Email, change: Change): Email =>
	"done" in change
		? { ...e, doneAt: change.done ? new Date() : null }
		: "to" in change
			? { ...e, folder: change.to, why: { ...e.why, folder: "by-hand" } }
			: "important" in change
				? {
						...e,
						important: change.important,
						why: { ...e.why, important: "by-hand" },
					}
				: { ...e, readAt: change.read ? new Date() : null };

// Where an email is listed.
const belongs = (view: MarketView, e: Email) =>
	view === "done"
		? e.doneAt !== null
		: e.doneAt === null &&
			(view === "important" ? e.important : e.folder === view);

// Moves the email's counts (unread open emails per folder, and important),
// and takes it off the list shown when it no longer belongs there.
function changed(key: string, view: MarketView, email: Email, change: Change) {
	const next = after(email, change);
	return mail.patch(key, (d) => {
		const c = { ...d.counts };
		const tally = (e: Email, by: 1 | -1) => {
			if (e.doneAt !== null || e.readAt !== null) return;
			c[e.folder] += by;
			if (e.important) c.important += by;
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

export function MarketplaceBox({
	view,
	market,
	page,
	counts,
}: {
	view: MarketView;
	market: Market | null;
	page: MarketMailPage;
	counts: InboxCounts;
}) {
	const key = `${view}|${market ?? "all"}`;
	const d = mail.useData(key, page);

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
								data: { id: email.id, important: c.important },
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
			isDone ? "Done" : `Back in ${FOLDER_NAMES[e.folder]}`,
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
	const star = (e: Email) =>
		make(
			e,
			{ important: !e.important },
			e.important ? "Not important" : "Important",
			{
				change: {
					important: e.why.important === "by-hand" ? e.important : null,
				},
				said: "Put back",
			},
		);

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
				onShown={(e) => e.readAt === null && read(e, true)}
				actionsOf={(e) => (
					<Actions
						email={e}
						market={market}
						onDone={(isDone) => done(e, isDone)}
						onMove={(to) => move(e, to)}
						onStar={() => star(e)}
						onRead={() => read(e, e.readAt === null)}
					/>
				)}
				keysOf={(e) => ({
					e: () => done(e, e.doneAt === null),
					i: () => star(e),
					u: () => read(e, e.readAt === null),
				})}
				menuOf={(e) => (
					<>
						<ContextMenuItem
							shortcut="E"
							onSelect={() => done(e, e.doneAt === null)}
						>
							{e.doneAt === null ? <Archive /> : <Undo2 />}
							{e.doneAt === null ? "Done" : `Back to ${FOLDER_NAMES[e.folder]}`}
						</ContextMenuItem>
						<ContextMenuItem
							shortcut="U"
							onSelect={() => read(e, e.readAt === null)}
						>
							{e.readAt === null ? <MailOpen /> : <Mail />}
							{e.readAt === null ? "Mark read" : "Mark unread"}
						</ContextMenuItem>
						<ContextMenuItem shortcut="I" onSelect={() => star(e)}>
							<Star className={cn(e.important && "fill-current")} />
							{e.important ? "Not important" : "Important"}
						</ContextMenuItem>
						<ContextMenuSeparator />
						{FOLDERS.filter((f) => f !== e.folder).map((f) => {
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
		</InboxFrame>
	);
}

// In a row: a star when important, the folder where the list mixes them,
// and the marketplace where it isn't filtered to one.
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
			{e.important && view !== "important" && (
				<Star className="size-3.5 fill-warning-fill text-warning-text" />
			)}
			{(view === "important" || view === "done") && (
				<Badge>{FOLDER_NAMES[e.folder]}</Badge>
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
	onRead,
}: {
	email: Email;
	market: Market | null;
	onDone: (done: boolean) => void;
	onMove: (to: Folder) => void;
	onStar: () => void;
	onRead: () => void;
}) {
	return (
		<>
			{/* The chips sit left; the buttons after them keep to the right. */}
			<span className="mr-auto flex min-w-0 items-center gap-1.5">
				{e.market && market === null && (
					<ChannelBadge channel={e.market} salesChannel={null} />
				)}
				<WhyChip email={e} />
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
			<Tip content={e.important ? "Not important (I)" : "Important (I)"}>
				<Button
					size="sm"
					variant="ghost"
					aria-pressed={e.important}
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
			<MoveMenu from={e.folder} onMove={onMove} />
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
					Back to {FOLDER_NAMES[e.folder]}
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
						: `Nothing in ${FOLDER_NAMES[view]}`
			}
		/>
	);
}
