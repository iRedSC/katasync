import { Link, useRouter } from "@tanstack/react-router";
import {
	Archive,
	ExternalLink,
	Languages,
	NotebookPen,
	SendHorizontal,
	Undo2,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { refuseWords, rulesFor } from "#/buyers/attachments";
import { chatPage } from "#/buyers/chat-page";
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
import { offerUndo } from "#/lib/undo";
import { cn } from "#/lib/utils";
import { translateReply } from "#/server/buyer-drafts";
import { logBuyerReply, unlogBuyerReply } from "#/server/buyers";
import { Bubble, KeptReply, type Shown } from "./buyer-bubble";
import { BuyerOrder } from "./buyer-order";
import { DueChip } from "./due-chip";
import { groupMarketplace, MarketplaceBubble } from "./marketplace-bubble";
import {
	HOLD_MS,
	hold,
	isEmptyBox,
	keepReturned,
	type Returned,
	retry,
	setRefresh,
	takeReturned,
	undo,
	useOutgoing,
	useReturned,
} from "./outgoing";
import { AttachButton, AttachedFiles, useReplyFiles } from "./reply-files";
import { Suggestion } from "./suggestion";

// "Spanish" for es, in English.
const languages = new Intl.DisplayNames(["en"], { type: "language" });
const languageName = (code: string | null) =>
	code ? (languages.of(code) ?? code) : "their language";

// One conversation: the buyer's messages on the left, ours on the right,
// each of ours marked with how far it got, the marketplace's own among them,
// and a reply box under them.
// A reply shows at once as sending, then moves on as the server learns.

export function BuyerConversation({
	thread: t,
	ai,
	order,
	onDone,
}: {
	thread: BuyerThread;
	// Whether the AI is set up: translating and drafting need it.
	ai: boolean;
	// The order it's opened from (an order page), which the header shows and
	// a suggestion is about. A buyer's one conversation can be opened from
	// any of their orders; without one, it's the thread's own.
	order?: { id: number; ref: string };
	onDone: (done: boolean) => void;
}) {
	const router = useRouter();
	const outgoing = useOutgoing();
	const [why, setWhy] = useState<string | null>(null);
	const files = useReplyFiles(t.market, (reason) => {
		setWhy(reason);
		shake(box.current);
	});
	const [text, setText] = useState("");
	const [dragging, setDragging] = useState(false);
	useEffect(() => {
		setRefresh(() => router.invalidate());
	});
	// Undo gives a reply's words and files back, also while this thread is
	// open. An empty box takes it at once; a box with something newer in it is
	// left alone, and the reply waits above it to be added when staff want it.
	const returnedReplies = useReturned(t.id);
	const offered = useRef(new Set<string>());
	useEffect(() => {
		for (const r of returnedReplies) {
			if (offered.current.has(r.key)) continue;
			offered.current.add(r.key);
			if (!isEmptyBox({ text, files: files.items.length })) continue;
			if (!files.restore(r.media)) continue;
			takeReturned(r.key);
			setText(r.body);
			box.current?.focus();
			// The box is no longer empty; the rest wait.
			break;
		}
	});
	// Adds a kept reply to the box after what's there.
	function addReturned(r: Returned) {
		if (!files.restore(r.media)) return shake(box.current);
		takeReturned(r.key);
		setText((now) => (now.trim() ? `${now.trimEnd()}\n\n${r.body}` : r.body));
		box.current?.focus();
	}
	function dropReturned(r: Returned) {
		takeReturned(r.key);
		offerUndo("Reply let go", {
			undo: async () => {
				keepReturned(r);
				return "Kept";
			},
		});
	}
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
	// The marketplace's own, in among them by time.
	const theirs = groupMarketplace(t.marketplace);
	const timeline = [
		...shown.map((m) => ({ key: m.key, at: m.at, m })),
		...theirs.map((item) => ({ key: item.key, at: item.at, item })),
	].sort((a, b) => new Date(a.at).getTime() - new Date(b.at).getTime());
	const count = timeline.length;
	useEffect(() => {
		if (count) end.current?.scrollIntoView({ block: "end" });
	}, [count]);

	const limit = rulesFor(t.market)?.maxChars ?? null;
	const over = refuseWords(t.market, text.trim()) !== null;

	// Holds words (and the box's files) as a reply, then sends them; undo
	// takes them back. A key given (a suggestion's) sends them once however
	// many times it's clicked; media given (sending one again) goes instead
	// of the box's files.
	function send(body: string, key?: string, again?: Shown["media"]) {
		const words = body.trim();
		const media = again ?? files.media();
		const problem =
			refuseWords(t.market, words) ??
			(!again && files.busy ? "Still uploading" : null) ??
			(t.market === "ebay" && !words && media.length > 0
				? "eBay needs words with the files"
				: null);
		if ((!words && media.length === 0) || problem) {
			shake(box.current);
			setWhy(problem);
			box.current?.focus();
			return;
		}
		const requestKey = key ?? crypto.randomUUID();
		if (!hold({ key: requestKey, threadId: t.id, body: words, media })) return;
		setText("");
		if (!again) files.clear();
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
		else send(m.body, undefined, m.media ?? []);
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
						orderId={order?.id}
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
				<ChatLink thread={t} />
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
				{timeline.map((e) =>
					"m" in e ? (
						<Bubble
							key={e.key}
							message={e.m}
							emailed={t.market === "shopify"}
							onAgain={() => again(e.m)}
						/>
					) : (
						<MarketplaceBubble key={e.key} item={e.item} market={t.market} />
					),
				)}
				<div ref={end} />
			</div>
			{/* The suggestion sits outside the form, so none of its buttons can
			    submit a reply. */}
			<div className="border-t p-3">
				<Suggestion
					thread={t}
					orderRef={order ? order.ref : t.orderRef}
					ai={ai}
					onEdit={(body, english) => {
						setText(body);
						setGloss(english ? { english, for: body.trim() } : null);
						box.current?.focus();
					}}
				/>
				{returnedReplies.map((r) => (
					<KeptReply
						key={r.key}
						reply={r}
						onAdd={() => addReturned(r)}
						onDrop={() => dropReturned(r)}
					/>
				))}
				<form
					onSubmit={(e) => {
						e.preventDefault();
						send(text);
					}}
					onDragOver={(e) => {
						if (!files.takesFiles || !e.dataTransfer.types.includes("Files"))
							return;
						e.preventDefault();
						setDragging(true);
					}}
					onDragLeave={() => setDragging(false)}
					onDrop={(e) => {
						if (!files.takesFiles) return;
						e.preventDefault();
						setDragging(false);
						setWhy(null);
						void files.add([...e.dataTransfer.files]);
					}}
				>
					<div
						className={cn(
							"rounded-lg border bg-background transition-colors focus-within:ring-2 focus-within:ring-ring",
							(over || why) && "border-critical-text",
							dragging && "border-primary bg-primary/5 ring-2 ring-primary",
						)}
					>
						<AttachedFiles files={files} />
						<textarea
							ref={box}
							value={text}
							rows={Math.min(8, Math.max(2, text.split("\n").length))}
							onChange={(e) => {
								setText(e.target.value);
								setWhy(null);
								if (!e.target.value.trim()) setGloss(null);
							}}
							onPaste={(e) => {
								const pasted = [...e.clipboardData.files];
								if (pasted.length === 0 || !files.takesFiles) return;
								e.preventDefault();
								setWhy(null);
								void files.add(pasted);
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
							<AttachButton files={files} />
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
												disabled={!text.trim() && files.items.length === 0}
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

// The conversation on the marketplace's site. TikTok's inbox can't be opened
// at one chat, so the buyer's name goes on the clipboard for its search.
function ChatLink({ thread: t }: { thread: BuyerThread }) {
	const page = chatPage(t);
	if (!page) return null;
	const { copy } = page;
	return (
		<Tip content={copy ? `Copies "${copy}" for its search` : "Open the chat"}>
			<Button size="sm" variant="ghost" asChild>
				<a
					href={page.url}
					target="_blank"
					rel="noreferrer"
					onClick={() => {
						if (copy)
							navigator.clipboard
								.writeText(copy)
								.then(() => toast.success(`Copied ${copy}`));
					}}
				>
					<ExternalLink />
					{page.name}
				</a>
			</Button>
		</Tip>
	);
}
