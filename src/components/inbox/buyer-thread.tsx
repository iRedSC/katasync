import { Link, useRouter } from "@tanstack/react-router";
import {
	Archive,
	Check,
	CheckCheck,
	CircleAlert,
	ExternalLink,
	LoaderCircle,
	RotateCw,
	SendHorizontal,
	Undo2,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { ReplyStatus } from "#/buyers/states";
import type { BuyerThread } from "#/buyers/threads";
import { shake } from "#/components/shake";
import { Button } from "#/components/ui/button";
import { Tip } from "#/components/ui/tooltip";
import { formatDateTime } from "#/lib/format";
import { cn } from "#/lib/utils";
import { replyToBuyer } from "#/server/buyers";
import { DueChip } from "./due-chip";

// One conversation: the buyer's messages on the left, ours on the right,
// each of ours marked with how far it got, and a reply box under them.
// A reply shows at once as sending, then moves on as the server learns.

const EBAY_MAX = 2000;

type Shown = {
	key: string;
	fromBuyer: boolean;
	body: string;
	at: Date;
	status: ReplyStatus | null;
	error: string | null;
};

// Replies written here and not yet back from the server, or that the
// server refused outright (never kept, so only here).
type Local = Shown & { serverId: number | null };

export function BuyerConversation({
	thread: t,
	onDone,
}: {
	thread: BuyerThread;
	onDone: (done: boolean) => void;
}) {
	const router = useRouter();
	const [local, setLocal] = useState<Local[]>([]);
	const [text, setText] = useState("");
	const [why, setWhy] = useState<string | null>(null);
	const box = useRef<HTMLTextAreaElement>(null);
	const end = useRef<HTMLDivElement>(null);

	const kept = new Set(t.messages.map((m) => m.id));
	const shown: Shown[] = [
		...t.messages.map((m) => ({ ...m, key: `m${m.id}` })),
		...local.filter((l) => l.serverId === null || !kept.has(l.serverId)),
	];
	const count = shown.length;
	useEffect(() => {
		if (count) end.current?.scrollIntoView({ block: "end" });
	}, [count]);

	const limit = t.market === "ebay" ? EBAY_MAX : null;
	const over = limit !== null && text.trim().length > limit;

	async function send(body: string) {
		const words = body.trim();
		if (!words || over) {
			shake(box.current);
			setWhy(over ? `eBay takes ${limit} characters` : null);
			box.current?.focus();
			return;
		}
		const key = `l${Date.now()}`;
		const at = new Date();
		const mine: Local = {
			key,
			fromBuyer: false,
			body: words,
			at,
			status: "sending",
			error: null,
			serverId: null,
		};
		setLocal((l) => [...l, mine]);
		setText("");
		setWhy(null);
		const set = (patch: Partial<Local>) =>
			setLocal((l) => l.map((m) => (m.key === key ? { ...m, ...patch } : m)));
		try {
			const r = await replyToBuyer({ data: { threadId: t.id, text: words } });
			set({ serverId: r.id, status: r.status });
			await router.invalidate();
		} catch (error) {
			// Never kept: nothing went, and the words come back to fix.
			setLocal((l) => l.filter((m) => m.key !== key));
			setText(words);
			setWhy(error instanceof Error ? error.message : String(error));
			shake(box.current);
		}
	}

	return (
		<div className="flex min-h-0 flex-1 flex-col animate-in fade-in-0 slide-in-from-right-2">
			<header className="flex flex-wrap items-center gap-2 border-b px-4 py-3">
				<div className="mr-auto min-w-0">
					<p className="truncate font-semibold">{t.buyerName ?? "Buyer"}</p>
					<p className="truncate text-sm text-muted-foreground">
						{t.orderId ? (
							<Link
								to="/orders/$id"
								params={{ id: String(t.orderId) }}
								className="hover:underline"
							>
								Order {t.orderName}
							</Link>
						) : t.orderRef ? (
							`Order ${t.orderRef}`
						) : t.itemRef ? (
							<a
								href={`https://www.ebay.com/itm/${t.itemRef}`}
								target="_blank"
								rel="noreferrer"
								className="inline-flex items-center gap-1 hover:underline"
							>
								{t.subject}
								<ExternalLink className="size-3" />
							</a>
						) : (
							t.subject
						)}
					</p>
				</div>
				{t.waiting && <DueChip due={t.waiting.due} now={Date.now()} />}
				{t.doneAt === null ? (
					<Tip content="Needs no reply (E)">
						<Button size="sm" variant="secondary" onClick={() => onDone(true)}>
							<Archive />
							Done
						</Button>
					</Tip>
				) : (
					<Button size="sm" variant="secondary" onClick={() => onDone(false)}>
						<Undo2 />
						Reopen
					</Button>
				)}
			</header>
			<div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-4 py-4">
				{shown.map((m) => (
					<Bubble key={m.key} message={m} onAgain={() => send(m.body)} />
				))}
				<div ref={end} />
			</div>
			<form
				className="border-t p-3"
				onSubmit={(e) => {
					e.preventDefault();
					send(text);
				}}
			>
				<div className="flex items-end gap-2">
					<textarea
						ref={box}
						value={text}
						rows={Math.min(8, Math.max(2, text.split("\n").length))}
						onChange={(e) => {
							setText(e.target.value);
							setWhy(null);
						}}
						onKeyDown={(e) => {
							if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
								e.preventDefault();
								send(text);
							}
						}}
						placeholder={`Reply to ${t.buyerName ?? "the buyer"}`}
						className={cn(
							"min-w-0 flex-1 resize-none rounded-lg border bg-background px-3 py-2 outline-none focus:ring-2 focus:ring-ring",
							(over || why) && "border-critical-text",
						)}
					/>
					<Tip content="Send (Ctrl+Enter)">
						<Button type="submit" aria-label="Send" disabled={!text.trim()}>
							<SendHorizontal />
						</Button>
					</Tip>
				</div>
				{(why || (limit !== null && text.length > limit - 200)) && (
					<p
						className={cn(
							"mt-1 text-xs tabular-nums",
							why || over ? "text-critical-text" : "text-muted-foreground",
						)}
					>
						{why ?? `${text.trim().length} / ${limit}`}
					</p>
				)}
			</form>
		</div>
	);
}

const STATUS: Record<
	ReplyStatus,
	{ icon: typeof Check; label: string; className?: string }
> = {
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
};

function Bubble({
	message: m,
	onAgain,
}: {
	message: Shown;
	onAgain: () => void;
}) {
	const s = m.status ? STATUS[m.status] : null;
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
				)}
			>
				{m.body}
			</div>
			<span className="flex items-center gap-1 text-xs text-muted-foreground">
				{formatDateTime(m.at)}
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
			{m.status === "failed" && (
				<span className="flex items-center gap-2 text-xs text-critical-text">
					{m.error}
					<Button size="sm" variant="ghost" onClick={onAgain}>
						<RotateCw />
						Send again
					</Button>
				</span>
			)}
		</div>
	);
}
