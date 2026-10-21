import { Inbox, Link2, Loader2, Mail } from "lucide-react";
import { useEffect, useState } from "react";
import { EmailReader } from "#/components/emails/reader";
import { EmailRow } from "#/components/emails/row";
import { EmptyState } from "#/components/page";
import { Button } from "#/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogTitle,
} from "#/components/ui/dialog";
import { optimism } from "#/lib/optimism";
import { offerUndo } from "#/lib/undo";
import type { EmailToLink } from "#/purchasing/inbox/views";
import {
	emailsToLinkTo,
	filePoEmail,
	setAsidePoEmail,
} from "#/server/purchasing";
import { poData } from "./po-data";

type Load =
	| { state: "loading" }
	| { state: "failed"; message: string }
	| { state: "loaded"; emails: EmailToLink[] };

// Puts an email the inbox couldn't place on this PO, from the PO itself.
export function LinkEmail({ purchaseOrderId }: { purchaseOrderId: number }) {
	const [open, setOpen] = useState(false);
	return (
		<>
			<Button
				size="sm"
				variant="ghost"
				className="text-muted-foreground"
				onClick={() => setOpen(true)}
			>
				<Mail />
				Link an email
			</Button>
			<Dialog open={open} onOpenChange={setOpen}>
				<DialogContent className="flex h-[85vh] flex-col gap-0 p-0 sm:max-w-6xl">
					<DialogTitle className="border-b px-5 py-4 text-base">
						Link an email to PO {purchaseOrderId}
					</DialogTitle>
					<DialogDescription className="sr-only">
						Emails not on any PO, the likeliest first
					</DialogDescription>
					{open && <Picker purchaseOrderId={purchaseOrderId} />}
				</DialogContent>
			</Dialog>
		</>
	);
}

const tagOf = (e: EmailToLink) =>
	e.match === "mentions"
		? "Names this PO"
		: e.match === "supplier"
			? "From supplier"
			: e.setAsideAt
				? "Set aside"
				: null;

function Picker({ purchaseOrderId }: { purchaseOrderId: number }) {
	const [load, setLoad] = useState<Load>({ state: "loading" });
	const [attempt, setAttempt] = useState(0);
	const [selectedId, setSelectedId] = useState<number | null>(null);
	// biome-ignore lint/correctness/useExhaustiveDependencies: attempt is Try again
	useEffect(() => {
		let current = true;
		setLoad({ state: "loading" });
		emailsToLinkTo({ data: { id: purchaseOrderId } }).then(
			(emails) => current && setLoad({ state: "loaded", emails }),
			(err) =>
				current &&
				setLoad({
					state: "failed",
					message: err instanceof Error ? err.message : String(err),
				}),
		);
		return () => {
			current = false;
		};
	}, [purchaseOrderId, attempt]);

	const emails = load.state === "loaded" ? load.emails : [];
	const found = emails.findIndex((e) => e.id === selectedId);
	const index = Math.max(found, 0);
	const selected = emails[index] ?? null;

	// Off the list at once, and onto the timeline behind the dialog. The one
	// after it opens.
	async function link(email: EmailToLink) {
		const rest = emails.filter((e) => e.id !== email.id);
		setSelectedId(rest[Math.min(index, rest.length - 1)]?.id ?? null);
		const listed = (change: (all: EmailToLink[]) => EmailToLink[]) =>
			setLoad((l) =>
				l.state === "loaded" ? { ...l, emails: change(l.emails) } : l,
			);
		listed((all) => all.filter((e) => e.id !== email.id));
		const r = await optimism.change({
			label: `Linking to PO ${purchaseOrderId}`,
			patch: poData.patch(purchaseOrderId, (d) => ({
				...d,
				emails: [
					{
						...email,
						purchaseOrderId,
						matchedBy: "staff" as const,
						setAsideAt: null,
					},
					...d.emails,
				],
			})),
			send: () => filePoEmail({ data: { emailId: email.id, purchaseOrderId } }),
		});
		if (!r) {
			listed((all) => [email, ...all]);
			return;
		}
		offerUndo(`Linked to PO ${purchaseOrderId}`, {
			tone: "success",
			undo: async () => {
				const back = await optimism.change({
					label: "Taking the email off",
					patch: poData.patch(purchaseOrderId, (d) => ({
						...d,
						emails: d.emails.filter((e) => e.id !== email.id),
					})),
					send: async () => {
						await filePoEmail({
							data: { emailId: email.id, purchaseOrderId: null },
						});
						if (email.setAsideAt)
							await setAsidePoEmail({ data: { id: email.id, aside: true } });
					},
				});
				return back ? "Email taken off" : null;
			},
		});
	}

	if (load.state === "loading")
		return (
			<p className="flex flex-1 items-center justify-center gap-2 text-muted-foreground">
				<Loader2 className="size-4 animate-spin" />
				Loading
			</p>
		);
	if (load.state === "failed")
		return (
			<div className="flex flex-1 flex-col items-center justify-center gap-3">
				<p className="text-critical-text">{load.message}</p>
				<Button variant="outline" onClick={() => setAttempt((n) => n + 1)}>
					Try again
				</Button>
			</div>
		);
	if (selected === null)
		return <EmptyState icon={Inbox} title="Every email is on a PO" />;
	return (
		<div className="grid min-h-0 flex-1 grid-cols-[20rem_minmax(0,1fr)]">
			<ul className="min-h-0 divide-y overflow-y-auto border-r">
				{emails.map((e) => (
					<EmailRow
						key={e.id}
						email={e}
						selected={e.id === selected.id}
						onOpen={() => setSelectedId(e.id)}
						tag={tagOf(e)}
					/>
				))}
			</ul>
			<EmailReader
				key={selected.id}
				email={selected}
				className="min-h-0 animate-in fade-in-0 slide-in-from-right-2"
				actions={
					<Button size="sm" onClick={() => link(selected)}>
						<Link2 />
						Link to PO {purchaseOrderId}
					</Button>
				}
			/>
		</div>
	);
}
