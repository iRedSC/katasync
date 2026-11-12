import { Mail } from "lucide-react";
import { useState } from "react";
import { EmailReader, snippet } from "#/components/emails/reader";
import { Badge, Card } from "#/components/page";
import { Dialog, DialogContent, DialogTitle } from "#/components/ui/dialog";
import { formatCount, formatOrderDate } from "#/lib/format";
import { cn } from "#/lib/utils";
import type { OrderDetail } from "#/server/orders";

type Email = OrderDetail["mail"]["emails"][number];

// The marketplace emails that name the order, newest first. A click opens
// one over the page, read as the inbox reads it. With none, there's no card.
export function MailCard({ mail }: { mail: OrderDetail["mail"] }) {
	const [open, setOpen] = useState<Email | null>(null);
	const entries = [...mail.emails].sort(
		(a, b) =>
			new Date(b.receivedAt).getTime() - new Date(a.receivedAt).getTime(),
	);
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
						key={e.id}
						email={e}
						open={open?.id === e.id}
						onOpen={() => setOpen(e)}
					/>
				))}
			</ul>
			<Dialog open={open !== null} onOpenChange={(o) => !o && setOpen(null)}>
				{open && (
					<DialogContent className="flex h-[min(85svh,56rem)] flex-col gap-0 overflow-hidden p-0 sm:max-w-3xl">
						<DialogTitle className="sr-only">{open.subject}</DialogTitle>
						<EmailReader
							key={open.id}
							email={open}
							box="marketplaces"
							fileUrl={(a) => `/api/market-email-attachments/${a.id}`}
							className="min-h-0 flex-1"
						/>
					</DialogContent>
				)}
			</Dialog>
		</Card>
	);
}

function Row({
	email: e,
	open,
	onOpen,
}: {
	email: Email;
	open: boolean;
	onOpen: () => void;
}) {
	const level = e.critical
		? { tone: "critical" as const, label: "Critical" }
		: e.important
			? { tone: "warning" as const, label: "Important" }
			: null;
	const preview = snippet(e.body);
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
				<Mail className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
				<span className="min-w-0 flex-1">
					<span className="flex items-baseline gap-2">
						<span className="min-w-0 flex-1 truncate font-medium">
							{e.subject || "(no subject)"}
						</span>
						<span className="shrink-0 text-xs text-muted-foreground">
							{formatOrderDate(e.receivedAt)}
						</span>
					</span>
					<span className="block truncate text-xs text-muted-foreground">
						{e.fromName ?? e.fromAddress}
						{preview && ` · ${preview}`}
					</span>
					{level && (
						<span className="mt-1 flex">
							<Badge tone={level.tone}>{level.label}</Badge>
						</span>
					)}
				</span>
			</button>
		</li>
	);
}
