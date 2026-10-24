import { Link } from "@tanstack/react-router";
import { Inbox, Mail, MailOpen, Sparkles, Undo2, X } from "lucide-react";
import { toast } from "sonner";
import { PoPicker } from "#/components/emails/po-picker";
import { EmptyState } from "#/components/page";
import { Button } from "#/components/ui/button";
import { ContextMenuItem } from "#/components/ui/context-menu";
import { optimism, optimistic } from "#/lib/optimism";
import { offerUndo } from "#/lib/undo";
import type { InboxView } from "#/purchasing/inbox/ingest";
import type { InboxPage } from "#/purchasing/inbox/views";
import type { InboxCounts } from "#/server/inbox";
import {
	filePoEmail,
	setAsidePoEmail,
	setPoEmailRead,
	takeAiSuggestion,
	undoAiFiling,
} from "#/server/purchasing";
import { AiFiling } from "./ai-filing";
import { type PurchasingView, purchasingView } from "./folders";
import { InboxFrame } from "./frame";
import { MailPane } from "./mail-pane";

// The purchasing folders on the Inbox page: suppliers' emails, filed on
// their POs. Linking one opens the next.

type Email = InboxPage["emails"][number];

// Where an email is: on a PO, waiting to be filed, or set aside as about no PO.
type Place = { po: number } | "to-file" | "set-aside";

const placeOf = (e: Email): Place =>
	e.purchaseOrderId !== null
		? { po: e.purchaseOrderId }
		: e.setAsideAt
			? "set-aside"
			: "to-file";

const viewOf = (p: Place): InboxView => (typeof p === "object" ? "filed" : p);

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
			? "Back in To file"
			: "Set aside";

const inbox = optimistic<InboxPage>("po-emails");

// The email leaves the list it's in unless it stays there (moved from one PO
// to another), and the tab counts follow it.
function moved(
	view: InboxView,
	email: Email,
	to: Place,
	pos: InboxPage["pos"],
) {
	const from = viewOf(placeOf(email));
	// Only unread emails are counted.
	const count = (v: InboxView) =>
		email.readAt !== null
			? 0
			: (v === viewOf(to) ? 1 : 0) - (v === from ? 1 : 0);
	return inbox.patch(view, (d) => ({
		...d,
		counts: {
			toFile: d.counts.toFile + count("to-file"),
			setAside: d.counts.setAside + count("set-aside"),
		},
		emails:
			viewOf(to) === view && typeof to === "object"
				? d.emails.map((e) =>
						e.id !== email.id
							? e
							: {
									...e,
									purchaseOrderId: to.po,
									poSupplier: pos.find((p) => p.id === to.po)?.supplier ?? null,
									likelyPos: e.likelyPos.filter((id) => id !== to.po),
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
				toFile: d.counts.toFile + (place === "to-file" ? by : 0),
				setAside: d.counts.setAside + (place === "set-aside" ? by : 0),
			},
			emails: d.emails.map((e) =>
				e.id === email.id ? { ...e, readAt: read ? new Date() : null } : e,
			),
		};
	});
}

export function PurchasingBox({
	view: folder,
	page,
	counts,
}: {
	view: PurchasingView;
	page: InboxPage;
	counts: InboxCounts;
}) {
	const view = purchasingView(folder);
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
		<InboxFrame
			folder={folder}
			market={null}
			counts={{ ...counts, ...d.counts }}
		>
			<MailPane
				box="purchasing"
				emails={d.emails}
				tagOf={(e) =>
					e.purchaseOrderId !== null && (
						<span className="inline-flex items-center gap-1">
							{e.matchedBy === "ai" && <Sparkles className="size-3" />}
							PO {e.purchaseOrderId}
						</span>
					)
				}
				aboutOf={(e) => (
					<AiFiling
						email={e}
						onTake={(po) => takeAi(e, po)}
						onUndo={() => undoAi(e)}
					/>
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
									{place === "set-aside" ? "Back to To file" : "Take off PO"}
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
			{typeof place === "object" && (
				<Button asChild size="sm" variant="secondary">
					<Link
						to="/purchasing/$id"
						params={{ id: String(place.po) }}
						className="tabular-nums"
					>
						PO {place.po}
						{e.poSupplier && (
							<span className="font-normal opacity-80">{e.poSupplier}</span>
						)}
					</Link>
				</Button>
			)}
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
					{place === "set-aside" ? "Back to To file" : "Take off PO"}
				</Button>
			)}
		</>
	);
}

function Empty({ view, connected }: { view: InboxView; connected: boolean }) {
	if (!connected && view === "to-file")
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
			title={
				view === "to-file"
					? "Every email is filed"
					: view === "set-aside"
						? "Nothing set aside"
						: "No emails on POs yet"
			}
		/>
	);
}
