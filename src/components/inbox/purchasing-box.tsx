import { Link } from "@tanstack/react-router";
import { Copy, Inbox, Mail, MailOpen, Sparkles, Undo2, X } from "lucide-react";
import { toast } from "sonner";
import { PoPicker } from "#/components/emails/po-picker";
import { EmptyState } from "#/components/page";
import { Button } from "#/components/ui/button";
import { ContextMenuItem } from "#/components/ui/context-menu";
import { optimism, optimistic } from "#/lib/optimism";
import { offerUndo } from "#/lib/undo";
import { cn } from "#/lib/utils";
import type { InboxView } from "#/purchasing/inbox/ingest";
import type { InboxPage } from "#/purchasing/inbox/views";
import type { InboxCounts } from "#/server/inbox";
import {
	filePoEmail,
	setAsidePoEmail,
	setPoEmailRead,
	takeAiSuggestion,
	undoAiFiling,
	undoAiSetAside,
} from "#/server/purchasing";
import { AiFiling } from "./ai-filing";
import { EmailPo } from "./email-po";
import type { PurchasingView } from "./folders";
import { InboxFrame } from "./frame";
import { MailPane } from "./mail-pane";

// The purchasing folders on the Inbox page: suppliers' emails waiting to be
// filed, and those filed, each tagged with where it went and whether the AI
// put it there. Filing one opens the next.

type Email = InboxPage["emails"][number];

// Where an email is: on a PO, waiting to be filed, or set aside as about no PO.
type Place = { po: number } | "to-file" | "set-aside";

const placeOf = (e: Email): Place =>
	e.purchaseOrderId !== null
		? { po: e.purchaseOrderId }
		: e.setAsideAt
			? "set-aside"
			: "to-file";

const viewOf = (p: Place): InboxView => (p === "to-file" ? "unfiled" : "filed");

// Filing clears set-aside, so going to set-aside takes it off any PO first.
async function sendTo(id: number, place: Place) {
	await filePoEmail({
		data: {
			emailId: id,
			purchaseOrderId: typeof place === "object" ? place.po : null,
		},
	});
	if (place === "set-aside")
		await setAsidePoEmail({ data: { id, aside: true } });
}

const said = (p: Place) =>
	typeof p === "object"
		? `Linked to PO ${p.po}`
		: p === "to-file"
			? "Back in Unfiled"
			: "Set aside";

const inbox = optimistic<InboxPage>("po-emails");

// The email leaves the list it's in unless it stays there (filed elsewhere),
// retagged, and Unfiled's count follows it.
function moved(
	view: InboxView,
	email: Email,
	to: Place,
	pos: InboxPage["pos"],
) {
	const from = viewOf(placeOf(email));
	// Only unread emails are counted.
	const by =
		email.readAt !== null || from === viewOf(to)
			? 0
			: viewOf(to) === "unfiled"
				? 1
				: -1;
	const po = typeof to === "object" ? to.po : null;
	return inbox.patch(view, (d) => ({
		...d,
		counts: { unfiled: d.counts.unfiled + by },
		emails:
			viewOf(to) === view
				? d.emails.map((e) =>
						e.id !== email.id
							? e
							: {
									...e,
									purchaseOrderId: po,
									matchedBy: po === null ? null : ("staff" as const),
									setAsideAt: to === "set-aside" ? new Date() : null,
									poSupplier: pos.find((p) => p.id === po)?.supplier ?? null,
									likelyPos: e.likelyPos.filter((id) => id !== po),
								},
					)
				: d.emails.filter((e) => e.id !== email.id),
	}));
}

// Read or unread: the row changes, and the count of its list with it.
function marked(view: InboxView, email: Email, read: boolean) {
	const place = viewOf(placeOf(email));
	return inbox.patch(view, (d) => {
		const by = (email.readAt === null) === read ? (read ? -1 : 1) : 0;
		return {
			...d,
			counts: {
				unfiled: d.counts.unfiled + (place === "unfiled" ? by : 0),
			},
			emails: d.emails.map((e) =>
				e.id === email.id ? { ...e, readAt: read ? new Date() : null } : e,
			),
		};
	});
}

export function PurchasingBox({
	view,
	page,
	counts,
}: {
	view: PurchasingView;
	page: InboxPage;
	counts: InboxCounts;
}) {
	const d = inbox.useData(view, page);

	async function move(email: Email, to: Place) {
		const from = placeOf(email);
		const r = await optimism.change({
			label: said(to),
			patch: moved(view, email, to, d.pos),
			send: () => sendTo(email.id, to),
		});
		if (!r) return;
		offerUndo(said(to), {
			tone: typeof to === "object" ? "success" : undefined,
			undo: async () => {
				const back = await optimism.change({
					label: "Putting it back",
					patch: [],
					send: () => sendTo(email.id, from),
				});
				return back ? said(from) : null;
			},
		});
	}

	// Takes the AI's undo: what someone changed since stays, and says so.
	async function undoAi(email: Email) {
		const r = await optimism.change({
			label: "Undoing",
			patch: moved(view, email, "to-file", d.pos),
			send: () => undoAiFiling({ data: { id: email.id } }),
		});
		if (!r) return;
		if (r.value.kept.length > 0)
			toast.warning("Undone, but kept", {
				description: r.value.kept.join(", "),
			});
		else toast(said("to-file"));
	}

	// Brings back an email the AI set aside as a copy.
	async function undoAiAside(email: Email) {
		const r = await optimism.change({
			label: "Undoing",
			patch: moved(view, email, "to-file", d.pos),
			send: () => undoAiSetAside({ data: { id: email.id } }),
		});
		if (!r) return;
		if (r.value.kept.length > 0)
			toast.warning("Undone, but kept", {
				description: r.value.kept.join(", "),
			});
		else toast(said("to-file"));
	}

	async function takeAi(email: Email, po: number) {
		const r = await optimism.change({
			label: said({ po }),
			patch: moved(view, email, { po }, d.pos),
			send: () => takeAiSuggestion({ data: { id: email.id } }),
		});
		if (!r) return;
		offerUndo(said({ po }), {
			tone: "success",
			undo: async () => {
				const back = await optimism.change({
					label: "Putting it back",
					patch: [],
					send: () => undoAiFiling({ data: { id: email.id } }),
				});
				if (!back) return null;
				return back.value.kept.length > 0
					? `Kept ${back.value.kept.join(", ")}`
					: said("to-file");
			},
		});
	}

	const read = (email: Email, isRead: boolean) =>
		optimism.change({
			label: isRead ? "Read" : "Unread",
			patch: marked(view, email, isRead),
			send: () => setPoEmailRead({ data: { id: email.id, read: isRead } }),
		});

	return (
		<InboxFrame folder={view} market={null} counts={{ ...counts, ...d.counts }}>
			<MailPane
				box="purchasing"
				emails={d.emails}
				tagOf={(e) => <Decision email={e} />}
				aboutOf={(e) => (
					// Hidden when it has nothing to show.
					<div className="flex flex-col gap-2 border-b px-5 py-3 empty:hidden">
						{e.purchaseOrderId !== null && (
							<EmailPo po={e.purchaseOrderId} supplier={e.poSupplier} />
						)}
						<AiFiling
							email={e}
							onTake={(po) => takeAi(e, po)}
							onUndo={() => undoAi(e)}
							onUndoAside={() => undoAiAside(e)}
						/>
					</div>
				)}
				unreadOf={(e) => e.readAt === null}
				onShown={(e) => e.readAt === null && read(e, true)}
				keysOf={(e) => ({ u: () => read(e, e.readAt === null) })}
				actionsOf={(e) => (
					<Actions email={e} pos={d.pos} onMove={(to) => move(e, to)} />
				)}
				menuOf={(e) => {
					const place = placeOf(e);
					return (
						<>
							{place === "to-file" ? (
								<ContextMenuItem onSelect={() => move(e, "set-aside")}>
									<X />
									Not a PO
								</ContextMenuItem>
							) : (
								<ContextMenuItem onSelect={() => move(e, "to-file")}>
									<Undo2 />
									{place === "set-aside" ? "Back to Unfiled" : "Take off PO"}
								</ContextMenuItem>
							)}
							<ContextMenuItem
								shortcut="U"
								onSelect={() => read(e, e.readAt === null)}
							>
								{e.readAt === null ? <MailOpen /> : <Mail />}
								{e.readAt === null ? "Mark read" : "Mark unread"}
							</ContextMenuItem>
						</>
					);
				}}
				empty={<Empty view={view} connected={d.connected} />}
			/>
		</InboxFrame>
	);
}

function Actions({
	email: e,
	pos,
	onMove,
}: {
	email: Email;
	pos: InboxPage["pos"];
	onMove: (to: Place) => void;
}) {
	const place = placeOf(e);
	return (
		<>
			<PoPicker
				pos={pos}
				likely={e.likelyPos}
				onPick={(po) => onMove({ po })}
				label={typeof place === "object" ? "Move to PO" : "Link to PO"}
			/>
			{place === "to-file" ? (
				<Button size="sm" variant="ghost" onClick={() => onMove("set-aside")}>
					<X />
					Not a PO
				</Button>
			) : (
				<Button size="sm" variant="ghost" onClick={() => onMove("to-file")}>
					<Undo2 />
					{place === "set-aside" ? "Back to Unfiled" : "Take off PO"}
				</Button>
			)}
		</>
	);
}

// What was decided for it, in the list: the PO it's on, or set aside as about
// none or as a copy; the AI's guess while it waits. A sparkle marks the AI's.
function Decision({ email: e }: { email: Email }) {
	const ai = e.ai;
	const place = placeOf(e);
	const byAi =
		typeof place === "object"
			? e.matchedBy === "ai"
			: place === "set-aside"
				? ai?.state === "set_aside"
				: ai !== null &&
					(ai.state === "suggested" ||
						ai.state === "unmatched" ||
						ai.state === "working");
	const label =
		typeof place === "object" ? (
			`PO ${place.po}`
		) : place === "set-aside" ? (
			ai?.state === "set_aside" ? (
				<>
					<Copy className="size-3" />
					Copy
				</>
			) : (
				"Not a PO"
			)
		) : ai?.state === "suggested" ? (
			`PO ${ai.purchaseOrderId}?`
		) : ai?.state === "unmatched" ? (
			"No PO"
		) : null;
	if (!byAi && label === null) return null;
	return (
		<span
			className={cn(
				"inline-flex items-center gap-1 rounded-md px-1.5 text-xs font-medium tabular-nums",
				place === "to-file"
					? "text-muted-foreground"
					: place === "set-aside"
						? "bg-surface-strong text-muted-foreground"
						: "bg-surface-strong",
			)}
		>
			{byAi && (
				<Sparkles
					className={cn(
						"size-3",
						ai?.state === "working" && place === "to-file" && "animate-pulse",
					)}
				/>
			)}
			{label}
		</span>
	);
}

function Empty({ view, connected }: { view: InboxView; connected: boolean }) {
	if (!connected && view === "unfiled")
		return (
			<EmptyState icon={Inbox} title="The purchasing inbox isn't connected">
				<Link to="/diagnostics" className="text-link hover:underline">
					Diagnostics
				</Link>{" "}
				shows what it needs.
			</EmptyState>
		);
	return (
		<EmptyState
			icon={Inbox}
			title={view === "unfiled" ? "Every email is filed" : "Nothing filed yet"}
		/>
	);
}
