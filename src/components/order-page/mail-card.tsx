import { ChevronRight, Mail, MessageSquare } from "lucide-react";
import { useState } from "react";
import { MailText, snippet } from "#/components/emails/reader";
import { Badge, Card } from "#/components/page";
import { channelName, formatCount, formatOrderDate } from "#/lib/format";
import { cn } from "#/lib/utils";
import type { OrderDetail } from "#/server/orders";

type Email = OrderDetail["mail"]["emails"][number];
type Thread = OrderDetail["mail"]["threads"][number];

// Everything written about the order: marketplace emails that name it and
// buyers' conversations about it, newest first. Each opens in place. With
// none, there's no card.
export function MailCard({ mail }: { mail: OrderDetail["mail"] }) {
	const entries = [
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
				{entries.map((e) =>
					e.kind === "email" ? (
						<EmailRow key={e.key} email={e.email} />
					) : (
						<ThreadRow key={e.key} thread={e.thread} />
					),
				)}
			</ul>
		</Card>
	);
}

function Row({
	icon,
	title,
	from,
	at,
	preview,
	tags,
	children,
}: {
	icon: React.ReactNode;
	title: string;
	from: string;
	at: Date;
	preview: string;
	tags?: React.ReactNode;
	children: React.ReactNode;
}) {
	const [open, setOpen] = useState(false);
	return (
		<li className="border-t">
			<button
				type="button"
				onClick={() => setOpen(!open)}
				aria-expanded={open}
				className="flex w-full items-start gap-3 px-4 py-2.5 text-left hover:bg-subtle"
			>
				<ChevronRight
					className={cn(
						"mt-0.5 size-4 shrink-0 text-muted-foreground transition-transform",
						open && "rotate-90",
					)}
				/>
				<span className="mt-0.5 shrink-0 text-muted-foreground">{icon}</span>
				<span className="min-w-0 flex-1">
					<span className="flex items-center gap-2">
						<span className="truncate font-medium">{title}</span>
						{tags}
					</span>
					<span className="block truncate text-xs text-muted-foreground">
						{from}
						{!open && preview && ` · ${preview}`}
					</span>
				</span>
				<span className="shrink-0 text-xs text-muted-foreground">
					{formatOrderDate(at)}
				</span>
			</button>
			{open && (
				<div className="border-t bg-subtle px-4 py-3 pl-14 whitespace-pre-wrap break-words">
					{children}
				</div>
			)}
		</li>
	);
}

function EmailRow({ email: e }: { email: Email }) {
	return (
		<Row
			icon={<Mail className="size-4" />}
			title={e.subject}
			from={e.fromName ?? e.fromAddress}
			at={e.receivedAt}
			preview={snippet(e.body)}
			tags={
				<>
					<Badge>{e.folder.charAt(0).toUpperCase() + e.folder.slice(1)}</Badge>
					{e.critical ? (
						<Badge tone="critical">Critical</Badge>
					) : (
						e.important && <Badge tone="warning">Important</Badge>
					)}
				</>
			}
		>
			<MailText text={e.body} />
		</Row>
	);
}

function ThreadRow({ thread: t }: { thread: Thread }) {
	const last = t.messages.at(-1);
	const waiting = last?.fromBuyer && t.doneAt === null;
	return (
		<Row
			icon={<MessageSquare className="size-4" />}
			title={t.subject}
			from={`${t.buyerName ?? "Buyer"} on ${channelName(t.market)} · ${formatCount(t.messages.length)} ${t.messages.length === 1 ? "message" : "messages"}`}
			at={last?.at ?? new Date(0)}
			preview={last ? snippet(last.english ?? last.body) : ""}
			tags={waiting && <Badge tone="info">Needs a reply</Badge>}
		>
			<ol className="flex flex-col gap-3 whitespace-normal">
				{t.messages.map((m) => (
					<li
						key={m.id}
						className={cn(
							"max-w-[85%] rounded-lg px-3 py-2",
							m.fromBuyer
								? "self-start bg-card shadow-card"
								: "self-end bg-info-fill",
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
		</Row>
	);
}
