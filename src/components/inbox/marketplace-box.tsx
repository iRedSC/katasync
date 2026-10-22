import { Link, useRouter } from "@tanstack/react-router";
import {
	Archive,
	ChevronDown,
	FolderInput,
	Inbox,
	RefreshCw,
	Undo2,
} from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { ChannelBadge } from "#/components/channel-badge";
import { Badge, EmptyState } from "#/components/page";
import { Button } from "#/components/ui/button";
import {
	ContextMenuItem,
	ContextMenuSeparator,
} from "#/components/ui/context-menu";
import {
	Popover,
	PopoverContent,
	PopoverTrigger,
} from "#/components/ui/popover";
import { Tip } from "#/components/ui/tooltip";
import type {
	MarketLabel,
	MarketMailPage,
	MarketView,
} from "#/inbox/market-mail";
import { formatDateTime } from "#/lib/format";
import { optimism, optimistic } from "#/lib/optimism";
import { offerUndo } from "#/lib/undo";
import { cn } from "#/lib/utils";
import { MARKETS, type Market } from "#/markets/market";
import {
	checkMarketMailNow,
	relabelMarketEmail,
	setMarketEmailDone,
} from "#/server/inbox";
import { MailPane, TabCount, tabClass } from "./mail-pane";

// The marketplaces mailbox on the Inbox page: what Amazon, eBay, TikTok Shop,
// and Shopify email, sorted so order notices never bury what needs someone.
// Done clears one off its list; one in the wrong list moves, and stays moved.

type Email = MarketMailPage["emails"][number];

export const LABELS: { view: MarketLabel; label: string }[] = [
	{ view: "attention", label: "Needs attention" },
	{ view: "orders", label: "Orders" },
	{ view: "returns", label: "Returns" },
	{ view: "updates", label: "Updates" },
];
const labelName = (l: MarketLabel) =>
	LABELS.find((x) => x.view === l)?.label ?? l;

const mail = optimistic<MarketMailPage>("market-emails");

// What happens to an email: done, back from done, or to another label.
type Change = "done" | "open" | { to: MarketLabel };

// Takes the email off the list shown, and moves its count between tabs.
function leaves(key: string, email: Email, change: Change) {
	return mail.patch(key, (d) => {
		const counts = { ...d.counts };
		if (change === "done") counts[email.label]--;
		else if (change === "open") counts[email.label]++;
		else {
			counts[email.label]--;
			counts[change.to]++;
		}
		return {
			...d,
			counts,
			emails: d.emails.filter((e) => e.id !== email.id),
		};
	});
}

export function MarketplaceBox({
	view,
	market,
	page,
}: {
	view: MarketView;
	market: Market | null;
	page: MarketMailPage;
}) {
	const key = `${view}|${market ?? "all"}`;
	const d = mail.useData(key, page);

	async function done(email: Email, isDone: boolean) {
		const said = isDone ? "Done" : `Back in ${labelName(email.label)}`;
		const r = await optimism.change({
			label: said,
			patch: leaves(key, email, isDone ? "done" : "open"),
			send: () => setMarketEmailDone({ data: { id: email.id, done: isDone } }),
		});
		if (!r) return;
		offerUndo(said, {
			undo: async () => {
				const back = await optimism.change({
					label: "Putting it back",
					patch: [],
					send: () =>
						setMarketEmailDone({ data: { id: email.id, done: !isDone } }),
				});
				return back ? "Put back" : null;
			},
		});
	}

	async function move(email: Email, to: MarketLabel) {
		const said = `Moved to ${labelName(to)}`;
		const r = await optimism.change({
			label: said,
			patch: leaves(key, email, { to }),
			send: () => relabelMarketEmail({ data: { id: email.id, label: to } }),
		});
		if (!r) return;
		offerUndo(said, {
			undo: async () => {
				const back = await optimism.change({
					label: "Putting it back",
					patch: [],
					send: () =>
						relabelMarketEmail({ data: { id: email.id, label: email.label } }),
				});
				return back ? `Back in ${labelName(email.label)}` : null;
			},
		});
	}

	const search = (v: MarketView, m: Market | null) => ({
		...(v === "attention" ? {} : { view: v }),
		...(m ? { market: m } : {}),
	});

	return (
		<>
			<div className="flex flex-wrap items-center gap-1 border-b p-2">
				{[...LABELS, { view: "done" as const, label: "Done" }].map((t) => (
					<Link
						key={t.view}
						to="/inbox"
						search={search(t.view, market)}
						className={tabClass(view === t.view)}
					>
						{t.label}
						{t.view !== "done" && <TabCount n={d.counts[t.view]} />}
					</Link>
				))}
				<span className="mx-1 h-5 w-px bg-border" />
				<Link
					to="/inbox"
					search={search(view, null)}
					className={tabClass(market === null)}
				>
					All
				</Link>
				{MARKETS.map((m) => (
					<Link
						key={m}
						to="/inbox"
						search={search(view, m)}
						className={tabClass(market === m)}
					>
						<ChannelBadge channel={m} salesChannel={null} compact />
					</Link>
				))}
				<CheckNow check={d.check} />
			</div>
			{d.check?.error && (
				<p className="border-b bg-critical-surface px-4 py-2 font-medium text-critical-text">
					Can't read the mailbox: {d.check.error}
				</p>
			)}
			<MailPane
				box="marketplaces"
				emails={d.emails}
				fileUrl={(a) => `/api/market-email-attachments/${a.id}`}
				tagOf={(e) => (
					<span className="flex items-center gap-1">
						{view === "done" && <Badge>{labelName(e.label)}</Badge>}
						{market === null && e.market && (
							<ChannelBadge channel={e.market} salesChannel={null} compact />
						)}
					</span>
				)}
				actionsOf={(e) => (
					<Actions
						email={e}
						onDone={(isDone) => done(e, isDone)}
						onMove={(to) => move(e, to)}
					/>
				)}
				keysOf={(e) => ({ e: () => done(e, e.doneAt === null) })}
				menuOf={(e) => (
					<>
						<ContextMenuItem
							shortcut="E"
							onSelect={() => done(e, e.doneAt === null)}
						>
							{e.doneAt === null ? <Archive /> : <Undo2 />}
							{e.doneAt === null ? "Done" : `Back to ${labelName(e.label)}`}
						</ContextMenuItem>
						{e.doneAt === null && (
							<>
								<ContextMenuSeparator />
								{LABELS.filter((l) => l.view !== e.label).map((l) => (
									<ContextMenuItem
										key={l.view}
										onSelect={() => move(e, l.view)}
									>
										<FolderInput />
										Move to {l.label}
									</ContextMenuItem>
								))}
							</>
						)}
					</>
				)}
				empty={<Empty view={view} connected={d.connected} />}
			/>
		</>
	);
}

function Actions({
	email: e,
	onDone,
	onMove,
}: {
	email: Email;
	onDone: (done: boolean) => void;
	onMove: (to: MarketLabel) => void;
}) {
	return (
		<>
			{/* The chip sits left; the buttons after it keep to the right. */}
			{e.market && (
				<span className="mr-auto">
					<ChannelBadge channel={e.market} salesChannel={null} />
				</span>
			)}
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
					Back to {labelName(e.label)}
				</Button>
			)}
			{e.doneAt === null && <MoveMenu from={e.label} onMove={onMove} />}
		</>
	);
}

// One Move button; the other folders in its menu.
function MoveMenu({
	from,
	onMove,
}: {
	from: MarketLabel;
	onMove: (to: MarketLabel) => void;
}) {
	const [open, setOpen] = useState(false);
	return (
		<Popover open={open} onOpenChange={setOpen}>
			<PopoverTrigger asChild>
				<Button size="sm" variant="ghost">
					<FolderInput />
					Move
					<ChevronDown className="opacity-60" />
				</Button>
			</PopoverTrigger>
			<PopoverContent align="end" className="w-48 p-1">
				{LABELS.filter((l) => l.view !== from).map((l) => (
					<button
						key={l.view}
						type="button"
						onClick={() => {
							setOpen(false);
							onMove(l.view);
						}}
						className="flex h-8 w-full items-center rounded-md px-2 text-left text-sm hover:bg-surface-strong"
					>
						{l.label}
					</button>
				))}
			</PopoverContent>
		</Popover>
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
				className="ml-auto"
				disabled={busy}
				aria-label="Check for new email"
				onClick={async () => {
					setBusy(true);
					try {
						const r = await checkMarketMailNow();
						if ("error" in r && r.error)
							toast.error("Couldn't read the mailbox", {
								description: r.error,
							});
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

function Empty({ view, connected }: { view: MarketView; connected: boolean }) {
	if (!connected)
		return (
			<EmptyState icon={Inbox} title="The marketplaces mailbox isn't connected">
				Set MARKETPLACE_INBOX to its address.
			</EmptyState>
		);
	return (
		<EmptyState
			icon={Inbox}
			title={
				view === "attention"
					? "Nothing needs attention"
					: view === "done"
						? "Nothing done yet"
						: `No ${labelName(view).toLowerCase()}`
			}
		/>
	);
}
