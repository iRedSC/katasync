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
import { AttachedEmail } from "./attached-email";
import { EmailBody } from "./html-body";

// An email as any of katasync's mailboxes keeps it.
export type ReadableEmail = {
	id: number;
	fromAddress: string;
	fromName: string | null;
	subject: string;
	body: string;
	receivedAt: Date;
	attachments: Attachment[];
};
type Attachment = {
	id: number;
	filename: string;
	contentType: string;
	size: number;
	// False when it was too large to keep.
	kept: boolean;
};

// Where a mailbox serves its files.
export type FileUrl = (a: { id: number }) => string;

export const kb = (bytes: number) =>
	bytes < 1_000_000
		? `${Math.max(1, Math.round(bytes / 1000))} KB`
		: `${(bytes / 1_000_000).toFixed(1)} MB`;

export const attachmentUrl: FileUrl = (a) =>
	`/api/po-email-attachments/${a.id}`;

// What the browser can show in the page; the rest download.
export function shownAs(a: Attachment) {
	if (!a.kept) return "missing";
	if (a.contentType === "message/rfc822" || /\.eml$/i.test(a.filename))
		return "email";
	if (a.contentType === "application/pdf") return "pdf";
	if (/^image\/(png|jpeg|gif|webp)$/.test(a.contentType)) return "image";
	return "download";
}

// Outlook's plain text keeps images as [url] and every link as "words <url>":
// noise to a person reading. A [url] is an image only when its file is one;
// a bracketed document link stays a link.
const IMAGE =
	/\[https?:\/\/[^\]\s]+\.(?:png|jpe?g|gif|webp)(?:[?#][^\]\s]*)?\]/gi;
const LINKED = /\[(https?:\/\/[^\]\s]+)\]/g;
const ANGLED = /<(https?:\/\/[^>\s]+)>/g;
const BARE = /https?:\/\/[^\s<>\]]+/g;

// The first words of the body, for a list row, without the links.
export function snippet(body: string) {
	return body
		.replace(LINKED, "")
		.replace(ANGLED, "")
		.replace(BARE, "")
		.replace(/\s+/g, " ")
		.trim()
		.slice(0, 140);
}

// The body as a person reads it: images gone, and each link a small arrow
// after the words it belongs to (or its site, when it stands alone), so a
// notice reads as its sentences.
export function MailText({ text }: { text: string }) {
	const parts: ReactNode[] = [];
	const cleaned = text.replace(IMAGE, "");
	let last = 0;
	for (const m of cleaned.matchAll(
		new RegExp(`${ANGLED.source}|${LINKED.source}|${BARE.source}`, "g"),
	)) {
		const url = m[1] ?? m[2] ?? m[0];
		parts.push(cleaned.slice(last, m.index));
		let host = url;
		try {
			host = new URL(url).hostname.replace(/^www\./, "");
		} catch {}
		parts.push(
			<a
				key={m.index}
				href={url}
				target="_blank"
				rel="noreferrer"
				className="mx-0.5 inline-flex items-center gap-0.5 rounded px-1 text-xs text-link hover:bg-surface"
			>
				{m[1] ? null : host}
				<ExternalLink className="size-3" />
			</a>,
		);
		last = (m.index ?? 0) + m[0].length;
	}
	parts.push(cleaned.slice(last));
	return <>{parts}</>;
}

// An email as a mail app shows it: who, when, and what, then a tab per file
// beside the message, so a PDF or photo reads without leaving the page.
// Keyed by the email's id where it's used, so a new email opens on its message.
export function EmailReader({
	email: e,
	actions,
	heading = true,
	box = "purchasing",
	fileUrl = attachmentUrl,
	className,
}: {
	email: ReadableEmail;
	// Which mailbox it's from, for its formatted version.
	box?: "purchasing" | "marketplaces";
	// Purchasing's unless given.
	fileUrl?: FileUrl;
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
						<div className="mt-3 flex flex-wrap items-center justify-end gap-1.5">
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
							url={fileUrl(a)}
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
					<FileView file={file} url={fileUrl(file)} />
				) : (
					<EmailBody
						box={box}
						id={e.id}
						text={
							<p className="px-5 py-4 text-sm whitespace-pre-wrap break-words">
								{e.body ? (
									<MailText text={e.body.replace(/\n{3,}/g, "\n\n")} />
								) : (
									<span className="text-muted-foreground">(empty)</span>
								)}
							</p>
						}
					/>
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
	url,
	active,
	onShow,
}: {
	file: Attachment;
	url: string;
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
				href={url}
				className="inline-flex h-7 max-w-64 items-center gap-1.5 rounded-lg px-2 text-xs font-medium text-muted-foreground hover:bg-surface hover:text-foreground"
			>
				<Download className="size-3.5 shrink-0" />
				{label}
			</a>
		);
	return (
		<Tab active={active} onClick={onShow}>
			{how === "email" ? (
				<Mail className="size-3.5 shrink-0" />
			) : (
				<FileText className="size-3.5 shrink-0" />
			)}
			{label}
		</Tab>
	);
}

export function FileView({ file: a, url }: { file: Attachment; url: string }) {
	return (
		<div className="flex h-full min-h-[60vh] flex-col">
			<div className="flex justify-end px-3 pt-2">
				{/* An email downloads, to open in Outlook; a tab can't show it. */}
				<a
					href={url}
					target="_blank"
					rel="noreferrer"
					className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-xs text-muted-foreground hover:bg-surface hover:text-foreground"
				>
					{shownAs(a) === "email" ? (
						<>
							<Download className="size-3" />
							Download
						</>
					) : (
						<>
							<ExternalLink className="size-3" />
							New tab
						</>
					)}
				</a>
			</div>
			{shownAs(a) === "email" ? (
				<AttachedEmail url={url} />
			) : shownAs(a) === "pdf" ? (
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
