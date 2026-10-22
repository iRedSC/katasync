import { Link, useRouter } from "@tanstack/react-router";
import {
	Archive,
	Check,
	CheckCheck,
	CircleAlert,
	CircleHelp,
	ExternalLink,
	Languages,
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
import { translateReply } from "#/server/buyer-drafts";
import { replyToBuyer } from "#/server/buyers";
import { DueChip } from "./due-chip";
import { Suggestion } from "./suggestion";

// "Spanish" for es, in English.
const languages = new Intl.DisplayNames(["en"], { type: "language" });
const languageName = (code: string | null) =>
	code ? (languages.of(code) ?? code) : "their language";

// One conversation: the buyer's messages on the left, ours on the right,
// each of ours marked with how far it got, and a reply box under them.
// A reply shows at once as sending, then moves on as the server learns.

const EBAY_MAX = 2000;

// unheard: the browser never got the server's answer, so it may or may not
// have gone; trying again with the same key can only send it once.
type Status = ReplyStatus | "unheard";

type Shown = {
	key: string;
	fromBuyer: boolean;
	body: string;
	at: Date;
	status: Status | null;
	error: string | null;
	// The buyer's words in English, when they wrote in another language.
	english?: string | null;
};

// Replies written here, until the server's list has them by their key.
type Local = Shown & { requestKey: string };

export function BuyerConversation({
	thread: t,
	ai,
	onDone,
}: {
	thread: BuyerThread;
	// Whether the AI is set up: translating and drafting need it.
	ai: boolean;
	onDone: (done: boolean) => void;
}) {
	const router = useRouter();
	const [local, setLocal] = useState<Local[]>([]);
	const [text, setText] = useState("");
	const [why, setWhy] = useState<string | null>(null);
	// The English the box's words say, kept with the exact words it's for:
	// any change to them hides it, since it no longer says what they do.
	const [gloss, setGloss] = useState<{ english: string; for: string } | null>(
		null,
	);
	const glossShown = gloss && gloss.for === text.trim() ? gloss.english : null;
	// The box's words as they are now, for a translation that comes back late.
	const current = useRef(text);
	current.current = text;
	const [translating, setTranslating] = useState(false);
	const foreign = ai && t.language !== null && t.language !== "en";

	async function translate() {
		const words = text.trim();
		if (!words) return shake(box.current);
		setTranslating(true);
		try {
			const r = await translateReply({ data: { threadId: t.id, text: words } });
			// Changed or sent meanwhile: the translation is of something else.
			if (current.current.trim() !== words) return;
			setGloss({ english: words, for: r.text.trim() });
			setText(r.text);
		} catch (error) {
			setWhy(error instanceof Error ? error.message : String(error));
			shake(box.current);
		} finally {
			setTranslating(false);
		}
	}
	const box = useRef<HTMLTextAreaElement>(null);
	const end = useRef<HTMLDivElement>(null);

	const kept = new Set(t.messages.map((m) => m.requestKey));
	const shown: Shown[] = [
		...t.messages.map((m) => ({ ...m, key: `m${m.id}` })),
		...local.filter((l) => !kept.has(l.requestKey)),
	];
	const count = shown.length;
	useEffect(() => {
		if (count) end.current?.scrollIntoView({ block: "end" });
	}, [count]);

	const limit = t.market === "ebay" ? EBAY_MAX : null;
	const over = limit !== null && text.trim().length > limit;

	// Sends a reply under its key: a new one from the box, or one whose
	// answer never came, again under the same key.
	async function deliver(mine: Local) {
		const set = (patch: Partial<Local>) =>
			setLocal((l) =>
				l.map((m) =>
					m.requestKey === mine.requestKey ? { ...m, ...patch } : m,
				),
			);
		set({ status: "sending", error: null });
		try {
			const r = await replyToBuyer({
				data: { threadId: t.id, text: mine.body, requestKey: mine.requestKey },
			});
			set({ status: r.status });
		} catch (error) {
			set({
				status: "unheard",
				error: error instanceof Error ? error.message : String(error),
			});
		}
		// The list catching up is apart from whether it sent.
		await router.invalidate().catch(() => {});
	}

	// Sends words as a reply. A key given (a suggestion's) sends them once
	// however many times it's clicked.
	function send(body: string, key?: string) {
		const words = body.trim();
		const tooLong = limit !== null && words.length > limit;
		if (key && local.some((l) => l.requestKey === key)) return;
		if (!words || tooLong) {
			shake(box.current);
			setWhy(tooLong ? `eBay takes ${limit} characters` : null);
			box.current?.focus();
			return;
		}
		const requestKey = key ?? crypto.randomUUID();
		const mine: Local = {
			key: requestKey,
			requestKey,
			fromBuyer: false,
			body: words,
			at: new Date(),
			status: "sending",
			error: null,
		};
		setLocal((l) => [...l, mine]);
		setText("");
		setGloss(null);
		setWhy(null);
		void deliver(mine);
	}

	const again = (m: Shown) => {
		const mine = local.find((l) => l.key === m.key);
		// Unheard: the same reply again. Failed or unconfirmed: a new one.
		if (mine && m.status === "unheard") void deliver(mine);
		else send(m.body);
	};

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
					<Bubble key={m.key} message={m} onAgain={() => again(m)} />
				))}
				<div ref={end} />
			</div>
			<Suggestion
				thread={t}
				ai={ai}
				onSend={send}
				onEdit={(body, english) => {
					setText(body);
					setGloss(english ? { english, for: body.trim() } : null);
					box.current?.focus();
				}}
			/>
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
							if (!e.target.value.trim()) setGloss(null);
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
					{foreign && (
						<Tip content={`Into ${languageName(t.language)}`}>
							<Button
								type="button"
								variant="ghost"
								aria-label="Translate"
								disabled={!text.trim() || translating}
								onClick={translate}
							>
								<Languages className={cn(translating && "animate-pulse")} />
							</Button>
						</Tip>
					)}
					<Tip content="Send (Ctrl+Enter)">
						<Button type="submit" aria-label="Send" disabled={!text.trim()}>
							<SendHorizontal />
						</Button>
					</Tip>
				</div>
				{glossShown && !why && (
					<p className="mt-1 truncate text-xs text-muted-foreground">
						{glossShown}
					</p>
				)}
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
	Status,
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

// What a reply that isn't through offers: the same send again, or a new one.
const AGAIN: Partial<Record<Status, string>> = {
	failed: "Send again",
	unconfirmed: "Send anyway",
	unheard: "Try again",
};

function Bubble({
	message: m,
	onAgain,
}: {
	message: Shown;
	onAgain: () => void;
}) {
	const s = m.status ? STATUS[m.status] : null;
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
				)}
			>
				{translated ? m.english : m.body}
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
			{m.status && AGAIN[m.status] && (
				<span
					className={cn(
						"flex max-w-[85%] items-center gap-2 text-right text-xs",
						m.status === "failed" ? "text-critical-text" : "text-warning-text",
					)}
				>
					{m.error}
					<Button size="sm" variant="ghost" onClick={onAgain}>
						<RotateCw />
						{AGAIN[m.status]}
					</Button>
				</span>
			)}
		</div>
	);
}
