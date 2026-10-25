import { useNavigate, useRouter } from "@tanstack/react-router";
import {
	CheckCheck,
	CircleHelp,
	ExternalLink,
	LoaderCircle,
	MessageSquare,
	SendHorizontal,
} from "lucide-react";
import { useRef, useState } from "react";
import { refuseWords } from "#/buyers/attachments";
import type { ChatWay, LastTry } from "#/buyers/chat-way";
import { BuyerConversation } from "#/components/inbox/buyer-thread";
import { shake } from "#/components/shake";
import { Button } from "#/components/ui/button";
import { Dialog, DialogContent, DialogTitle } from "#/components/ui/dialog";
import { Tip } from "#/components/ui/tooltip";
import { cn } from "#/lib/utils";
import {
	type getBuyerChat,
	openBuyerChat,
	sendFirstEbayMessage,
} from "#/server/buyer-chat";
import { setBuyerThreadDone } from "#/server/buyers";
import { type Attempt, firstMessageSender } from "./first-message-sender";

// Writing to the buyer from their order, whether or not they wrote first:
// their conversation opens over the page (?chat= names it), started first
// when there's none. Amazon takes a first message only on Seller Central.

type Chat = Awaited<ReturnType<typeof getBuyerChat>>;

export function MessageBuyer({
	orderId,
	way,
	chatId,
	chat,
}: {
	orderId: number;
	way: ChatWay;
	// The conversation open over the page, and what the page read of it.
	chatId: number | undefined;
	chat: Chat | null;
}) {
	const navigate = useNavigate();
	const router = useRouter();
	const button = useRef<HTMLButtonElement>(null);
	const [busy, setBusy] = useState(false);
	const [why, setWhy] = useState<string | null>(null);
	// eBay: no conversation until the first message.
	const [compose, setCompose] = useState<{
		to: string;
		last: LastTry | null;
	} | null>(null);
	const show = (threadId: number | undefined) =>
		navigate({
			to: ".",
			search: (s: Record<string, unknown>) => ({ ...s, chat: threadId }),
			replace: true,
			resetScroll: false,
		});
	const refuse = (reason: string) => {
		setWhy(reason);
		shake(button.current);
	};

	async function begin() {
		if (way.kind === "open") return show(way.threadId);
		setBusy(true);
		setWhy(null);
		try {
			const r = await openBuyerChat({ data: { orderId } });
			if (r.kind === "opened" || r.kind === "started") await show(r.threadId);
			else if (r.kind === "compose") setCompose({ to: r.to, last: r.last });
			else refuse(r.reason);
		} catch (error) {
			refuse(error instanceof Error ? error.message : String(error));
		} finally {
			setBusy(false);
		}
	}

	if (way.kind === "elsewhere")
		return (
			<Button size="sm" variant="secondary" className="mt-3 w-full" asChild>
				<a href={way.url} target="_blank" rel="noreferrer">
					<ExternalLink />
					Message on {way.name}
				</a>
			</Button>
		);
	return (
		<div className="mt-3">
			<Tip content={way.kind === "refused" ? way.reason : undefined}>
				{/* A disabled button gets no hover, so the tip sits on this. */}
				<span className="block">
					<Button
						ref={button}
						size="sm"
						variant="secondary"
						className={cn("w-full", why && "ring-2 ring-critical-text")}
						disabled={way.kind === "refused" || busy}
						onClick={begin}
					>
						{busy ? (
							<LoaderCircle className="animate-spin" />
						) : (
							<MessageSquare />
						)}
						Message buyer
					</Button>
				</span>
			</Tip>
			{why && <p className="mt-1 text-xs text-critical-text">{why}</p>}
			<Dialog
				open={chatId !== undefined}
				onOpenChange={(o) => !o && show(undefined)}
			>
				<DialogContent className="flex h-[min(85svh,48rem)] flex-col gap-0 overflow-hidden p-0 sm:max-w-2xl">
					<DialogTitle className="sr-only">
						Conversation with the buyer
					</DialogTitle>
					{chat?.thread ? (
						<BuyerConversation
							key={chat.thread.id}
							thread={chat.thread}
							ai={chat.ai}
							order={chat.order}
							onDone={async (done) => {
								await setBuyerThreadDone({
									data: { id: chat.thread?.id ?? 0, done },
								});
								await router.invalidate();
							}}
						/>
					) : (
						<p className="m-auto text-sm text-muted-foreground">
							That conversation is gone
						</p>
					)}
				</DialogContent>
			</Dialog>
			<Dialog
				open={compose !== null}
				onOpenChange={(o) => !o && setCompose(null)}
			>
				<DialogContent className="sm:max-w-xl">
					<DialogTitle className="text-base">
						Message {compose?.to} on eBay
					</DialogTitle>
					<FirstEbayMessage
						orderId={orderId}
						last={compose?.last ?? null}
						onSent={async (threadId) => {
							setCompose(null);
							await show(threadId);
						}}
					/>
				</DialogContent>
			</Dialog>
		</div>
	);
}

// The first message to an eBay buyer, which starts the conversation. It
// goes at once (no hold): eBay can't tell a second try from a new message.
// Each try is written down on the server under its key, so pressing again
// or asking after a lost answer never sends twice; one that may have gone
// shows again when the chat reopens, and only "Send anyway" tries again.
function FirstEbayMessage({
	orderId,
	last,
	onSent,
}: {
	orderId: number;
	// The order's last try that may have gone, from the server.
	last: LastTry | null;
	onSent: (threadId: number) => void;
}) {
	const box = useRef<HTMLTextAreaElement>(null);
	const sender = useRef(
		firstMessageSender((text, requestKey) =>
			sendFirstEbayMessage({ data: { orderId, text, requestKey } }),
		),
	).current;
	const [text, setText] = useState(last?.body ?? "");
	const [sending, setSending] = useState(false);
	const [shown, setShown] = useState<Attempt | null>(last?.outcome ?? null);
	const problem = refuseWords("ebay", text.trim());
	// It may have gone: sending again takes the explicit button.
	const doubt =
		shown?.kind === "unsure" ||
		shown?.kind === "lost" ||
		shown?.kind === "sending";

	async function send() {
		if (!text.trim() || problem) return shake(box.current);
		setSending(true);
		const r = await sender.send(text);
		setSending(false);
		// Another press already has a try out.
		if (!r) return;
		setShown(r);
		if (r.kind === "sent") return onSent(r.threadId);
		if (r.kind === "sent_unlisted") return setText("");
		shake(box.current);
	}

	if (shown?.kind === "sent_unlisted")
		return (
			<p className="flex items-center gap-2 text-sm animate-in fade-in-0 zoom-in-95">
				<CheckCheck className="size-4 text-success-icon" />
				Sent. It shows here once eBay lists it.
			</p>
		);
	const reason =
		problem ??
		(shown?.kind === "refused" ||
		shown?.kind === "unsure" ||
		shown?.kind === "lost"
			? shown.reason
			: shown?.kind === "sending"
				? "Still sending. Check eBay Messages before sending again"
				: null);
	// Lost or still sending: asking again reads the same try back.
	const label =
		shown?.kind === "lost" || (shown?.kind === "sending" && sender.open)
			? "Ask again"
			: doubt
				? "Send anyway"
				: "Send";
	return (
		<form
			onSubmit={(e) => {
				e.preventDefault();
				void send();
			}}
		>
			<div
				className={cn(
					"rounded-lg border bg-background focus-within:ring-2 focus-within:ring-ring",
					(shown?.kind === "refused" || problem) && "border-critical-text",
					doubt && "border-warning-text",
				)}
			>
				<textarea
					ref={box}
					// biome-ignore lint/a11y/noAutofocus: the dialog opens to write this.
					autoFocus
					value={text}
					// A try out or unknown keeps its words: asking again is that try.
					readOnly={sender.open}
					rows={Math.min(8, Math.max(3, text.split("\n").length))}
					onChange={(e) => {
						setText(e.target.value);
						if (shown?.kind === "refused") setShown(null);
					}}
					onKeyDown={(e) => {
						if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
							e.preventDefault();
							// Not after a try that may have gone.
							if (doubt && !sender.open) return shake(box.current);
							void send();
						}
					}}
					placeholder="Starts the conversation on eBay"
					className="block w-full resize-none rounded-t-lg bg-transparent px-3 pt-2 outline-none"
				/>
				<div className="flex justify-end px-1.5 pb-1.5">
					<Tip content={doubt ? undefined : "Send (Ctrl+Enter)"}>
						<Button
							type="submit"
							variant={doubt ? "secondary" : "default"}
							disabled={!text.trim() || sending}
						>
							{sending ? (
								<LoaderCircle className="animate-spin" />
							) : doubt ? (
								<CircleHelp />
							) : (
								<SendHorizontal />
							)}
							{label}
						</Button>
					</Tip>
				</div>
			</div>
			{reason && (
				<p
					className={cn(
						"mt-1 text-xs",
						doubt ? "text-warning-text" : "text-critical-text",
					)}
				>
					{reason}
				</p>
			)}
		</form>
	);
}
