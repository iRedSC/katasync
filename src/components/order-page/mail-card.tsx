import { Mail, MessageSquare } from "lucide-react";
import { useState } from "react";
import { EmailReader, snippet } from "#/components/emails/reader";
import { Badge, Card } from "#/components/page";
import { Dialog, DialogContent, DialogTitle } from "#/components/ui/dialog";
import { channelName, formatCount, formatOrderDate } from "#/lib/format";
import { cn } from "#/lib/utils";
import type { OrderDetail } from "#/server/orders";

type Email = OrderDetail["mail"]["emails"][number];
type Thread = OrderDetail["mail"]["threads"][number];
type Entry =
	| { kind: "email"; key: string; at: Date; email: Email }
	| { kind: "thread"; key: string; at: Date; thread: Thread };

// Everything written about the order: marketplace emails that name it and
// buyers' conversations about it, newest first. A click opens one over
// the page, read as the inbox reads it. With none, there's no card.
export function MailCard({ mail }: { mail: OrderDetail["mail"] }) {
	const [open, setOpen] = useState<Entry | null>(null);
	const entries: Entry[] = [
		...mail.emails.map((e) => ({
			kind: "email" as const,
			key: `e${e.id}`,
			at: e.receivedAt,
			email: e,
		})),
		...mail.threads.map((t) => ({
			kind: "thread" as const,
			key: `t${t.id}`,
			at: t.messages.at(-1)?.at ?? new Date(0),
			thread: t,
		})),
	].sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime());
	if (entries.length === 0) return null;
	return (
		<Card
			title="Mail"
			flush
			aside={
				<span className="text-xs text-muted-foreground tabular-nums">
					{formatCount(entries.length)}
				</span>
			}
		>
			<ul>
				{entries.map((e) => (
					<Row
						key={e.key}
						entry={e}
						open={open?.key === e.key}
						onOpen={() => setOpen(e)}
					/>
				))}
			</ul>
			<Dialog open={open !== null} onOpenChange={(o) => !o && setOpen(null)}>
				{open?.kind === "email" && (
					<DialogContent className="flex h-[min(85svh,56rem)] flex-col gap-0 overflow-hidden p-0 sm:max-w-3xl">
						<DialogTitle className="sr-only">{open.email.subject}</DialogTitle>
						<EmailReader
							key={open.email.id}
							email={open.email}
							box="marketplaces"
							fileUrl={(a) => `/api/market-email-attachments/${a.id}`}
							className="min-h-0 flex-1"
						/>
					</DialogContent>
				)}
				{open?.kind === "thread" && (
					<DialogContent className="flex max-h-[85svh] flex-col overflow-y-auto sm:max-w-xl">
						<Conversation thread={open.thread} />
					</DialogContent>
				)}
			</Dialog>
		</Card>
	);
}

function Row({
	entry: e,
	open,
	onOpen,
}: {
	entry: Entry;
	open: boolean;
	onOpen: () => void;
}) {
	const last = e.kind === "thread" ? e.thread.messages.at(-1) : undefined;
	const title = e.kind === "email" ? e.email.subject : e.thread.subject;
	const from =
		e.kind === "email"
			? (e.email.fromName ?? e.email.fromAddress)
			: `${e.thread.buyerName ?? "Buyer"} on ${channelName(e.thread.market)}`;
	const preview =
		e.kind === "email"
			? snippet(e.email.body)
			: last
				? snippet(last.english ?? last.body)
				: "";
	const Icon = e.kind === "email" ? Mail : MessageSquare;
	return (
		<li className="border-t first:border-t-0">
			<button
				type="button"
				onClick={onOpen}
				className={cn(
					"flex w-full items-start gap-2.5 px-4 py-2.5 text-left",
					open ? "bg-surface" : "hover:bg-subtle",
				)}
			>
				<Icon className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
				<span className="min-w-0 flex-1">
					<span className="flex items-baseline gap-2">
						<span className="min-w-0 flex-1 truncate font-medium">
							{title || "(no subject)"}
						</span>
						<span className="shrink-0 text-xs text-muted-foreground">
							{formatOrderDate(e.at)}
						</span>
					</span>
					<span className="block truncate text-xs text-muted-foreground">
						{from}
						{preview && ` · ${preview}`}
					</span>
					<Tags entry={e} />
				</span>
			</button>
		</li>
	);
}

function Tags({ entry: e }: { entry: Entry }) {
	if (e.kind === "thread") {
		const last = e.thread.messages.at(-1);
		return last?.fromBuyer && e.thread.doneAt === null ? (
			<span className="mt-1 flex">
				<Badge tone="info">Needs a reply</Badge>
			</span>
		) : null;
	}
	const level = e.email.critical
		? { tone: "critical" as const, label: "Critical" }
		: e.email.important
			? { tone: "warning" as const, label: "Important" }
			: null;
	return level ? (
		<span className="mt-1 flex">
			<Badge tone={level.tone}>{level.label}</Badge>
		</span>
	) : null;
}

function Conversation({ thread: t }: { thread: Thread }) {
	return (
		<>
			<DialogTitle className="pr-8 text-base">
				{t.subject || "(no subject)"}
			</DialogTitle>
			<p className="-mt-2 text-sm text-muted-foreground">
				{t.buyerName ?? "Buyer"} on {channelName(t.market)}
			</p>
			<ol className="flex flex-col gap-3">
				{t.messages.map((m) => (
					<li
						key={m.id}
						className={cn(
							"max-w-[85%] rounded-lg px-3 py-2",
							m.fromBuyer ? "self-start bg-surface" : "self-end bg-info-fill",
						)}
					>
						<div className="mb-1 text-xs text-muted-foreground">
							{m.fromBuyer ? (t.buyerName ?? "Buyer") : "Us"} ·{" "}
							{formatOrderDate(m.at)}
							{m.status === "failed" && (
								<span className="text-critical-text"> · Didn't send</span>
							)}
						</div>
						<div className="whitespace-pre-wrap break-words">
							{m.english ?? m.body}
						</div>
					</li>
				))}
			</ol>
		</>
	);
}
