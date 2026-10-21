import {
	Download,
	ExternalLink,
	FileText,
	Mail,
	Paperclip,
} from "lucide-react";
import { type ReactNode, useState } from "react";
import { Tip } from "#/components/ui/tooltip";
import { formatDateTime } from "#/lib/format";
import { cn } from "#/lib/utils";
import type { PurchaseOrderDetail } from "#/server/purchasing";

export type ReadableEmail = PurchaseOrderDetail["emails"][number];
type Attachment = ReadableEmail["attachments"][number];

export const kb = (bytes: number) =>
	bytes < 1_000_000
		? `${Math.max(1, Math.round(bytes / 1000))} KB`
		: `${(bytes / 1_000_000).toFixed(1)} MB`;

export const attachmentUrl = (a: Attachment) =>
	`/api/po-email-attachments/${a.id}`;

// What the browser can show in the page; the rest download.
function shownAs(a: Attachment) {
	if (!a.kept) return "missing";
	if (a.contentType === "application/pdf") return "pdf";
	if (/^image\/(png|jpeg|gif|webp)$/.test(a.contentType)) return "image";
	return "download";
}

// The first words of the body, for a list row.
export function snippet(body: string) {
	return body.replace(/\s+/g, " ").trim().slice(0, 140);
}

// An email as a mail app shows it: who, when, and what, then a tab per file
// beside the message, so a PDF or photo reads without leaving the page.
// Keyed by the email's id where it's used, so a new email opens on its message.
export function EmailReader({
	email: e,
	actions,
	heading = true,
	className,
}: {
	email: ReadableEmail;
	// Off where the sender and subject already show, as on a PO's timeline.
	heading?: boolean;
	// The bar under the header: filing it, setting it aside.
	actions?: ReactNode;
	className?: string;
}) {
	const [showing, setShowing] = useState<number | "message">("message");
	const file = e.attachments.find((a) => a.id === showing);

	return (
		<article className={cn("flex min-h-0 flex-col", className)}>
			{heading && (
				<header className="border-b px-5 pt-4 pb-3">
					<h2 className="text-base font-semibold break-words">
						{e.subject || "(no subject)"}
					</h2>
					<div className="mt-1 flex flex-wrap items-baseline gap-x-2 text-sm">
						<span className="font-medium">{e.fromName ?? e.fromAddress}</span>
						{e.fromName && (
							<span className="text-muted-foreground">{e.fromAddress}</span>
						)}
						<span className="ml-auto text-xs text-muted-foreground tabular-nums">
							{formatDateTime(e.receivedAt)}
						</span>
					</div>
					{actions && (
						<div className="mt-3 flex flex-wrap items-center gap-1.5">
							{actions}
						</div>
					)}
				</header>
			)}
			{e.attachments.length > 0 && (
				<nav className="flex flex-wrap gap-1.5 border-b px-5 py-2">
					<Tab
						active={showing === "message"}
						onClick={() => setShowing("message")}
					>
						<Mail className="size-3.5" />
						Message
					</Tab>
					{e.attachments.map((a) => (
						<FileTab
							key={a.id}
							file={a}
							active={showing === a.id}
							onShow={() => setShowing(a.id)}
						/>
					))}
				</nav>
			)}
			<div
				key={showing}
				className="min-h-0 flex-1 overflow-y-auto animate-in fade-in-0"
			>
				{file ? (
					<FileView file={file} />
				) : (
					<p className="px-5 py-4 text-sm whitespace-pre-wrap break-words">
						{e.body || <span className="text-muted-foreground">(empty)</span>}
					</p>
				)}
			</div>
			{!heading && actions && (
				<footer className="flex flex-wrap items-center gap-1.5 border-t px-3 py-2">
					{actions}
				</footer>
			)}
		</article>
	);
}

function Tab({
	active,
	onClick,
	children,
}: {
	active: boolean;
	onClick: () => void;
	children: ReactNode;
}) {
	return (
		<button
			type="button"
			onClick={onClick}
			className={cn(
				"inline-flex h-7 max-w-64 items-center gap-1.5 rounded-lg px-2 text-xs font-medium",
				active
					? "bg-surface-strong text-foreground"
					: "text-muted-foreground hover:bg-surface hover:text-foreground",
			)}
		>
			{children}
		</button>
	);
}

// A file the page can show is a tab; one it can't downloads; one too large
// to keep is named, dashed, with no link.
function FileTab({
	file: a,
	active,
	onShow,
}: {
	file: Attachment;
	active: boolean;
	onShow: () => void;
}) {
	const how = shownAs(a);
	const label = (
		<>
			<span className="truncate">{a.filename}</span>
			<span className="shrink-0 font-normal text-muted-foreground">
				{kb(a.size)}
			</span>
		</>
	);
	if (how === "missing")
		return (
			<Tip content="Too large to keep; it's in Outlook">
				<span className="inline-flex h-7 max-w-64 items-center gap-1.5 rounded-lg border border-dashed px-2 text-xs text-muted-foreground">
					<Paperclip className="size-3.5 shrink-0" />
					<span className="truncate">{a.filename}</span>
				</span>
			</Tip>
		);
	if (how === "download")
		return (
			<a
				href={attachmentUrl(a)}
				className="inline-flex h-7 max-w-64 items-center gap-1.5 rounded-lg px-2 text-xs font-medium text-muted-foreground hover:bg-surface hover:text-foreground"
			>
				<Download className="size-3.5 shrink-0" />
				{label}
			</a>
		);
	return (
		<Tab active={active} onClick={onShow}>
			<FileText className="size-3.5 shrink-0" />
			{label}
		</Tab>
	);
}

function FileView({ file: a }: { file: Attachment }) {
	const url = attachmentUrl(a);
	return (
		<div className="flex h-full min-h-[60vh] flex-col">
			<div className="flex justify-end px-3 pt-2">
				<a
					href={url}
					target="_blank"
					rel="noreferrer"
					className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-xs text-muted-foreground hover:bg-surface hover:text-foreground"
				>
					<ExternalLink className="size-3" />
					New tab
				</a>
			</div>
			{shownAs(a) === "pdf" ? (
				<iframe
					src={url}
					title={a.filename}
					className="min-h-[60vh] w-full flex-1"
				/>
			) : (
				<img
					src={url}
					alt={a.filename}
					className="mx-auto max-w-full object-contain p-3"
				/>
			)}
		</div>
	);
}
