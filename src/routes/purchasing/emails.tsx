import { createFileRoute, Link } from "@tanstack/react-router";
import { ArrowLeft, Inbox, Undo2, X } from "lucide-react";
import { useRef, useState } from "react";
import { PoPicker } from "#/components/emails/po-picker";
import { EmailReader } from "#/components/emails/reader";
import { EmailRow } from "#/components/emails/row";
import { Card, EmptyState, Page } from "#/components/page";
import { ListSkeleton } from "#/components/skeleton";
import { Button } from "#/components/ui/button";
import { formatCount } from "#/lib/format";
import { useHotkeys } from "#/lib/hotkeys";
import { optimism, optimistic } from "#/lib/optimism";
import { offerUndo } from "#/lib/undo";
import { cn } from "#/lib/utils";
import type { InboxView } from "#/purchasing/inbox/ingest";
import type { InboxPage } from "#/purchasing/inbox/views";
import {
	filePoEmail,
	listPoEmails,
	setAsidePoEmail,
} from "#/server/purchasing";

type Search = { view?: Exclude<InboxView, "to-file"> };

export const Route = createFileRoute("/purchasing/emails")({
	validateSearch: (search: Record<string, unknown>): Search =>
		search.view === "set-aside" || search.view === "filed"
			? { view: search.view }
			: {},
	loaderDeps: ({ search }): { view: InboxView } => ({
		view: search.view ?? "to-file",
	}),
	loader: ({ deps }) => listPoEmails({ data: { view: deps.view } }),
	component: SupplierEmails,
	pendingComponent: () => (
		<ListSkeleton
			title="Supplier emails"
			back={{ to: "/purchasing" }}
			width="wide"
		/>
	),
});

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

// The purchasing inbox as a mail app: the list on the left, the email on the
// right with its files, and linking it to a PO in its header. Linking one
// opens the next.
function SupplierEmails() {
	const { view } = Route.useLoaderDeps();
	const d = inbox.useData(view, Route.useLoaderData());
	const [selectedId, setSelectedId] = useState<number | null>(null);
	// On a phone the list and the email take turns.
	const [reading, setReading] = useState(false);
	// Where the open email sat, so the one after it opens once it leaves.
	const lastIndex = useRef(0);
	const found = d.emails.findIndex((e) => e.id === selectedId);
	const index =
		found >= 0 ? found : Math.min(lastIndex.current, d.emails.length - 1);
	lastIndex.current = Math.max(index, 0);
	const selected = d.emails[index] ?? null;

	const step = (by: number) => {
		const next = d.emails[index + by];
		if (next) setSelectedId(next.id);
	};
	useHotkeys({ j: () => step(1), k: () => step(-1) });

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
		<Page title="Supplier emails" back={{ to: "/purchasing" }} width="wide">
			<Card flush>
				<div className="flex gap-1 border-b p-2">
					{tabs.map((t) => (
						<Link
							key={t.view}
							to="/purchasing/emails"
							search={t.view === "to-file" ? {} : { view: t.view }}
							className={cn(
								"inline-flex h-7 items-center rounded-lg px-2.5 font-medium",
								view === t.view
									? "bg-surface-strong text-foreground"
									: "text-muted-foreground hover:bg-surface hover:text-foreground",
							)}
						>
							{t.label}
							{t.view !== "filed" && (
								<span className="ml-1.5 text-muted-foreground tabular-nums">
									{formatCount(
										t.view === "to-file" ? d.counts.toFile : d.counts.setAside,
									)}
								</span>
							)}
						</Link>
					))}
				</div>
				{selected === null ? (
					<Empty view={view} connected={d.connected} />
				) : (
					<div className="grid md:h-[calc(100svh-11.5rem)] md:min-h-[30rem] md:grid-cols-[24rem_minmax(0,1fr)]">
						<ul
							className={cn(
								"min-h-0 divide-y overflow-y-auto md:border-r",
								reading && "hidden md:block",
							)}
						>
							{d.emails.map((e) => (
								<EmailRow
									key={e.id}
									email={e}
									selected={e.id === selected.id}
									onOpen={() => {
										setSelectedId(e.id);
										setReading(true);
									}}
									tag={e.purchaseOrderId !== null && `PO ${e.purchaseOrderId}`}
								/>
							))}
						</ul>
						<div
							className={cn(
								"flex min-h-0 flex-col",
								!reading && "hidden md:flex",
							)}
						>
							<button
								type="button"
								onClick={() => setReading(false)}
								className="flex items-center gap-1 px-4 pt-3 text-muted-foreground md:hidden"
							>
								<ArrowLeft className="size-4" />
								Emails
							</button>
							<EmailReader
								key={selected.id}
								email={selected}
								className="min-h-0 flex-1 animate-in fade-in-0 slide-in-from-right-2"
								actions={
									<Actions
										email={selected}
										pos={d.pos}
										onMove={(to) => move(selected, to)}
									/>
								}
							/>
						</div>
					</div>
				)}
			</Card>
		</Page>
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
