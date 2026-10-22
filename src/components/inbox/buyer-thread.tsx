import { Link, useRouter } from "@tanstack/react-router";
import {
	Archive,
	Check,
	CheckCheck,
	CircleAlert,
	CircleHelp,
	Clock,
	ExternalLink,
	Languages,
	LoaderCircle,
	NotebookPen,
	RotateCw,
	SendHorizontal,
	Undo2,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { BuyerThread } from "#/buyers/threads";
import { shake } from "#/components/shake";
import { Button } from "#/components/ui/button";
import {
	ContextMenu,
	ContextMenuContent,
	ContextMenuItem,
	ContextMenuTrigger,
} from "#/components/ui/context-menu";
import { Tip } from "#/components/ui/tooltip";
import { formatDateTime } from "#/lib/format";
import { offerUndo } from "#/lib/undo";
import { cn } from "#/lib/utils";
import { translateReply } from "#/server/buyer-drafts";
import { logBuyerReply, unlogBuyerReply } from "#/server/buyers";
import { BuyerOrder } from "./buyer-order";
import { DueChip } from "./due-chip";
import {
	HOLD_MS,
	hold,
	type OutStatus,
	retry,
	sendNow,
	setRefresh,
	takeReturned,
	undo,
	useOutgoing,
} from "./outgoing";
import { Suggestion } from "./suggestion";

// "Spanish" for es, in English.
const languages = new Intl.DisplayNames(["en"], { type: "language" });
const languageName = (code: string | null) =>
	code ? (languages.of(code) ?? code) : "their language";

// One conversation: the buyer's messages on the left, ours on the right,
// each of ours marked with how far it got, and a reply box under them.
// A reply shows at once as sending, then moves on as the server learns.

const EBAY_MAX = 2000;

type Status = OutStatus;

type Shown = {
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
	const outgoing = useOutgoing();
	const [text, setText] = useState(() => takeReturned(t.id) ?? "");
	// Undo puts the words back in the box, also while this thread is open.
	useEffect(() => {
		setRefresh(() => router.invalidate());
		const back = takeReturned(t.id);
		if (back !== undefined) {
			setText(back);
			box.current?.focus();
		}
	});
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
		// Ours on their way, until the server's list has them by their key.
		...outgoing
			.filter((o) => o.threadId === t.id && !kept.has(o.key))
			.map((o) => ({ ...o, fromBuyer: false })),
	];
	const count = shown.length;
	useEffect(() => {
		if (count) end.current?.scrollIntoView({ block: "end" });
	}, [count]);

	const limit = t.market === "ebay" ? EBAY_MAX : null;
	const over = limit !== null && text.trim().length > limit;

	// Holds words as a reply, then sends them; undo takes them back. A key
	// given (a suggestion's) sends them once however many times it's clicked.
	function send(body: string, key?: string) {
		const words = body.trim();
		const tooLong = limit !== null && words.length > limit;
		if (!words || tooLong) {
			shake(box.current);
			setWhy(tooLong ? `eBay takes ${limit} characters` : null);
			box.current?.focus();
			return;
		}
		const requestKey = key ?? crypto.randomUUID();
		if (!hold({ key: requestKey, threadId: t.id, body: words })) return;
		setText("");
		setGloss(null);
		setWhy(null);
		offerUndo(`Sending in ${HOLD_MS / 1000}s`, {
			duration: HOLD_MS,
			undo: async () => (undo(requestKey) ? "Not sent" : null),
		});
	}

	// A reply sent on the marketplace itself, added so the thread matches.
	// Nothing goes to the buyer; undo takes it out and gives the words back.
	async function addWithoutSending() {
		const words = text.trim();
		if (!words) {
			shake(box.current);
			box.current?.focus();
			return;
		}
		const requestKey = crypto.randomUUID();
		setText("");
		setGloss(null);
		setWhy(null);
		try {
			await logBuyerReply({
				data: { threadId: t.id, text: words, requestKey },
			});
		} catch (error) {
			setText(words);
			setWhy(error instanceof Error ? error.message : String(error));
			shake(box.current);
			return;
		}
		await router.invalidate();
		offerUndo("Added without sending", {
			undo: async () => {
				await unlogBuyerReply({ data: { requestKey } });
				await router.invalidate();
				setText(words);
				return "Taken out";
			},
		});
	}

	const again = (m: Shown) => {
		// Unheard: the same reply again. Failed or unconfirmed: a new one.
		if (m.status === "unheard") retry(m.key);
		else send(m.body);
	};

	return (
		<div className="flex min-h-0 flex-1 flex-col animate-in fade-in-0 slide-in-from-right-2">
			<header className="flex items-start gap-3 border-b px-4 py-4">
				<div className="mr-auto flex min-w-0 flex-col gap-2">
					<p className="flex min-w-0 items-center gap-2">
						<span className="truncate text-base font-semibold">
							{t.buyerName ?? "Buyer"}
						</span>
						{t.waiting && <DueChip due={t.waiting.due} now={Date.now()} />}
					</p>
					<BuyerOrder
						threadId={t.id}
						fallback={
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
						}
					/>
				</div>
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
			{/* The suggestion sits outside the form, so none of its buttons can
			    submit a reply. */}
			<div className="border-t p-3">
				<Suggestion
					thread={t}
					ai={ai}
					onEdit={(body, english) => {
						setText(body);
						setGloss(english ? { english, for: body.trim() } : null);
						box.current?.focus();
					}}
				/>
				<form
					onSubmit={(e) => {
						e.preventDefault();
						send(text);
					}}
				>
					<div
						className={cn(
							"rounded-lg border bg-background focus-within:ring-2 focus-within:ring-ring",
							(over || why) && "border-critical-text",
						)}
					>
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
							className="block w-full resize-none rounded-t-lg bg-transparent px-3 pt-2 outline-none"
						/>
						<div className="flex items-center justify-end gap-1 px-1.5 pb-1.5">
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
							<ContextMenu>
								<ContextMenuTrigger asChild>
									<span>
										<Tip content="Send (Ctrl+Enter) · right-click for more">
											<Button
												type="submit"
												aria-label="Send"
												disabled={!text.trim()}
											>
												<SendHorizontal />
											</Button>
										</Tip>
									</span>
								</ContextMenuTrigger>
								<ContextMenuContent>
									<ContextMenuItem
										disabled={!text.trim()}
										onSelect={addWithoutSending}
									>
										<NotebookPen />
										Add to conversation without sending
									</ContextMenuItem>
								</ContextMenuContent>
							</ContextMenu>
						</div>
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

function Bubble({
	message: m,
	onAgain,
}: {
	message: Shown;
	onAgain: () => void;
}) {
	const s = m.logged ? LOGGED : m.status ? STATUS[m.status] : null;
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
