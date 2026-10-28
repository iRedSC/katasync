import {
	Check,
	CheckCheck,
	CircleAlert,
	CircleHelp,
	Clock,
	Languages,
	LoaderCircle,
	NotebookPen,
	Paperclip,
	RotateCw,
	SendHorizontal,
	Undo2,
	X,
} from "lucide-react";
import { useEffect, useState } from "react";
import type { ReplyFile } from "#/buyers/attachments";
import { Button } from "#/components/ui/button";
import { Tip } from "#/components/ui/tooltip";
import type { BuyerMedia } from "#/db/schema";
import { formatDateTime } from "#/lib/format";
import { cn } from "#/lib/utils";
import { type OutStatus, type Returned, sendNow, undo } from "./outgoing";

// The pieces of a conversation's thread: a message with how far it got, and
// a reply taken back, waiting to be added to the box.

type Status = OutStatus;

export type Shown = {
	// Pictures and files sent with it.
	media?: BuyerMedia[];
	// The same, of ours uploaded, as sending it again sends them.
	files?: ReplyFile[];
	// Added by staff after sending it on the marketplace; katasync sent
	// nothing.
	logged?: boolean;
	// When a held reply goes.
	sendAt?: number;
	key: string;
	fromBuyer: boolean;
	body: string;
	at: Date;
	status: Status | null;
	error: string | null;
	// The buyer's words in English, when they wrote in another language.
	english?: string | null;
};

// A reply taken back while the box held something newer, waiting to be added.
export function KeptReply({
	reply: r,
	onAdd,
	onDrop,
}: {
	reply: Returned;
	onAdd: () => void;
	onDrop: () => void;
}) {
	const files = r.media.length;
	return (
		<div className="mb-2 flex items-center gap-2 rounded-md bg-warning-surface px-2 py-1 text-sm text-warning-text animate-in fade-in-0 slide-in-from-bottom-1">
			<Undo2 className="size-3.5 shrink-0" />
			<span className="min-w-0 flex-1 truncate">
				{r.body || `${files} file${files === 1 ? "" : "s"}`}
			</span>
			<Button type="button" size="sm" variant="ghost" onClick={onAdd}>
				Add to reply
			</Button>
			<Tip content="Let go">
				<Button
					type="button"
					size="sm"
					variant="ghost"
					aria-label="Let go"
					onClick={onDrop}
				>
					<X />
				</Button>
			</Tip>
		</div>
	);
}

// A held reply's seconds left, ticking.
function Countdown({ at }: { at: number }) {
	const [, tick] = useState(0);
	useEffect(() => {
		const timer = setInterval(() => tick((n) => n + 1), 250);
		return () => clearInterval(timer);
	}, []);
	return <>{Math.max(0, Math.ceil((at - Date.now()) / 1000))}s</>;
}

// What came with a message: pictures as thumbnails, files as links, each
// opening full size in a new tab.
function Media({ items }: { items: BuyerMedia[] }) {
	if (items.length === 0) return null;
	const pictures = items.filter((i) => i.kind === "IMAGE");
	const files = items.filter((i) => i.kind !== "IMAGE");
	return (
		<span className="mt-1 flex flex-wrap gap-1.5 first:mt-0">
			{pictures.map((p) => (
				<a
					key={p.url}
					href={p.url}
					target="_blank"
					rel="noreferrer"
					className="block overflow-hidden rounded-lg ring-1 ring-black/10 transition-opacity hover:opacity-90"
				>
					<img
						src={p.url}
						alt={p.name || "Photo"}
						loading="lazy"
						className="h-36 w-auto max-w-56 object-cover"
					/>
				</a>
			))}
			{files.map((f) => (
				<a
					key={f.url}
					href={f.url}
					target="_blank"
					rel="noreferrer"
					className="inline-flex items-center gap-1 rounded-md bg-background/60 px-2 py-1 text-sm underline-offset-2 hover:underline"
				>
					<Paperclip className="size-3.5" />
					{f.name || f.kind}
				</a>
			))}
		</span>
	);
}

const STATUS: Record<
	Status,
	{ icon: typeof Check; label: string; className?: string }
> = {
	held: { icon: Clock, label: "Not sent yet" },
	sending: {
		icon: LoaderCircle,
		label: "Sending",
		className: "animate-spin",
	},
	sent: { icon: Check, label: "Sent, waiting for the marketplace" },
	delivered: { icon: CheckCheck, label: "Delivered" },
	failed: {
		icon: CircleAlert,
		label: "Didn't send",
		className: "text-critical-text",
	},
	unconfirmed: {
		icon: CircleHelp,
		label: "May not have sent",
		className: "text-warning-text",
	},
	unheard: {
		icon: CircleHelp,
		label: "No answer from katasync",
		className: "text-warning-text",
	},
};

// A Shopify buyer is emailed: delivered is only as far as their mail
// server, and whether they read it is never known.
const EMAILED: Partial<typeof STATUS> = {
	sent: { icon: Check, label: "Sent, on its way to their mail server" },
	delivered: { icon: CheckCheck, label: "Sent: their mail server took it" },
};

const LOGGED = {
	icon: NotebookPen,
	label: "Added without sending: sent on the marketplace",
	className: undefined,
};

// What a reply that isn't through offers: the same send again, or a new one.
const AGAIN: Partial<Record<Status, string>> = {
	failed: "Send again",
	unconfirmed: "Send anyway",
	unheard: "Try again",
};

export function Bubble({
	message: m,
	emailed = false,
	onAgain,
}: {
	message: Shown;
	emailed?: boolean;
	onAgain: () => void;
}) {
	const s = m.logged
		? LOGGED
		: m.status
			? ((emailed ? EMAILED[m.status] : undefined) ?? STATUS[m.status])
			: null;
	const [original, setOriginal] = useState(false);
	const translated = Boolean(m.english) && !original;
	return (
		<div
			className={cn(
				"flex flex-col gap-1 animate-in fade-in-0 slide-in-from-bottom-1",
				m.fromBuyer ? "items-start" : "items-end",
			)}
		>
			<div
				className={cn(
					"max-w-[85%] rounded-2xl px-3.5 py-2 whitespace-pre-wrap break-words",
					m.fromBuyer
						? "rounded-bl-md bg-surface-strong"
						: "rounded-br-md bg-primary text-primary-foreground",
					m.status === "failed" &&
						"bg-critical-surface text-critical-text ring-1 ring-critical-text",
					(m.status === "unconfirmed" || m.status === "unheard") &&
						"bg-warning-surface text-warning-text ring-1 ring-warning-text",
					// Not gone yet: dashed and faded until the hold runs out.
					m.status === "held" &&
						"bg-primary/60 outline-2 outline-primary outline-dashed outline-offset-2",
				)}
			>
				{(translated ? m.english : m.body) || null}
				<Media items={m.media ?? []} />
			</div>
			<span className="flex items-center gap-1 text-xs text-muted-foreground">
				{formatDateTime(m.at)}
				{m.english && (
					<button
						type="button"
						onClick={() => setOriginal((o) => !o)}
						className="inline-flex items-center gap-1 rounded px-1 hover:bg-surface hover:text-foreground"
					>
						<Languages className="size-3" />
						{translated ? "Original" : "English"}
					</button>
				)}
				{s && (
					<Tip content={m.error ?? s.label}>
						<s.icon
							key={m.status}
							aria-label={s.label}
							className={cn("size-3.5 animate-in zoom-in-75", s.className)}
						/>
					</Tip>
				)}
			</span>
			{m.status === "held" && m.sendAt !== undefined && (
				<span className="flex items-center gap-1 text-xs text-muted-foreground tabular-nums">
					Sends in <Countdown at={m.sendAt} />
					<Button
						type="button"
						size="sm"
						variant="ghost"
						onClick={() => undo(m.key)}
					>
						<Undo2 />
						Undo
					</Button>
					<Button
						type="button"
						size="sm"
						variant="ghost"
						onClick={() => sendNow(m.key)}
					>
						<SendHorizontal />
						Send now
					</Button>
				</span>
			)}
			{m.status && AGAIN[m.status] && (
				<span
					className={cn(
						"flex max-w-[85%] items-center gap-2 text-right text-xs",
						m.status === "failed" ? "text-critical-text" : "text-warning-text",
					)}
				>
					{m.error}
					<Button type="button" size="sm" variant="ghost" onClick={onAgain}>
						<RotateCw />
						{AGAIN[m.status]}
					</Button>
				</span>
			)}
		</div>
	);
}
