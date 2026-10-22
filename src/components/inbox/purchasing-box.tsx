import { Link } from "@tanstack/react-router";
import { Inbox, Undo2, X } from "lucide-react";
import { PoPicker } from "#/components/emails/po-picker";
import { EmptyState } from "#/components/page";
import { Button } from "#/components/ui/button";
import { optimism, optimistic } from "#/lib/optimism";
import { offerUndo } from "#/lib/undo";
import type { InboxView } from "#/purchasing/inbox/ingest";
import type { InboxPage } from "#/purchasing/inbox/views";
import { filePoEmail, setAsidePoEmail } from "#/server/purchasing";
import { MailPane, TabCount, tabClass } from "./mail-pane";

// The purchasing mailbox on the Inbox page: suppliers' emails, filed on
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
	const count = (v: InboxView) =>
		(v === viewOf(to) ? 1 : 0) - (v === from ? 1 : 0);
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

const tabs = [
	{ view: "to-file", label: "To file" },
	{ view: "set-aside", label: "Set aside" },
	{ view: "filed", label: "On a PO" },
] as const;

export function PurchasingBox({
	view,
	page,
}: {
	view: InboxView;
	page: InboxPage;
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

	return (
		<>
			<div className="flex flex-wrap gap-1 border-b p-2">
				{tabs.map((t) => (
					<Link
						key={t.view}
						to="/inbox"
						search={{
							box: "purchasing",
							...(t.view === "to-file" ? {} : { view: t.view }),
						}}
						className={tabClass(view === t.view)}
					>
						{t.label}
						{t.view !== "filed" && (
							<TabCount
								n={t.view === "to-file" ? d.counts.toFile : d.counts.setAside}
							/>
						)}
					</Link>
				))}
			</div>
			<MailPane
				emails={d.emails}
				tagOf={(e) => e.purchaseOrderId !== null && `PO ${e.purchaseOrderId}`}
				actionsOf={(e) => (
					<Actions email={e} pos={d.pos} onMove={(to) => move(e, to)} />
				)}
				empty={<Empty view={view} connected={d.connected} />}
			/>
		</>
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
