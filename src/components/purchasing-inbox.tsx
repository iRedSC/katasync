import { ChevronRight } from "lucide-react";
import { useState } from "react";
import { Card } from "#/components/page";
import { AttachmentChips } from "#/components/purchase-order/email-entry";
import { Button } from "#/components/ui/button";
import { formatDate, formatDateTime } from "#/lib/format";
import { optimism } from "#/lib/optimism";
import { offerUndo } from "#/lib/undo";
import { cn } from "#/lib/utils";
import { purchasingData } from "#/purchasing/list-patches";
import {
	filePoEmail,
	type PurchasingList,
	setAsidePoEmail,
} from "#/server/purchasing";

type Inbox = PurchasingList["inbox"];
type Email = Inbox["emails"][number];
type Po = Inbox["pos"][number];

const withoutEmail = (id: number) =>
	purchasingData.patch("all", (d) => ({
		...d,
		inbox: { ...d.inbox, emails: d.inbox.emails.filter((e) => e.id !== id) },
	}));

// Supplier emails the inbox couldn't put on a PO by itself. Filing one moves
// it to its PO's timeline; setting one aside drops it from here.
export function PurchasingInbox({ inbox }: { inbox: Inbox }) {
	if (inbox.emails.length === 0) return null;
	return (
		<Card title="Emails to file" aside={inbox.emails.length} flush>
			<ul className="divide-y">
				{inbox.emails.map((e) => (
					<EmailRow key={e.id} email={e} pos={inbox.pos} />
				))}
			</ul>
		</Card>
	);
}

function EmailRow({ email: e, pos }: { email: Email; pos: Po[] }) {
	const [open, setOpen] = useState(false);
	const likely = pos.filter((p) => e.likelyPos.includes(p.id));

	async function file(po: number) {
		const r = await optimism.change({
			label: `Filing on PO ${po}`,
			patch: withoutEmail(e.id),
			send: () => filePoEmail({ data: { emailId: e.id, purchaseOrderId: po } }),
		});
		if (!r) return;
		offerUndo(`Filed on PO ${po}`, {
			tone: "success",
			undo: async () => {
				const back = await optimism.change({
					label: "Unfiling",
					patch: [],
					send: () =>
						filePoEmail({ data: { emailId: e.id, purchaseOrderId: null } }),
				});
				return back ? "Back in emails to file" : null;
			},
		});
	}

	async function setAside() {
		const r = await optimism.change({
			label: "Setting the email aside",
			patch: withoutEmail(e.id),
			send: () => setAsidePoEmail({ data: { id: e.id, aside: true } }),
		});
		if (!r) return;
		offerUndo("Set aside", {
			undo: async () => {
				const back = await optimism.change({
					label: "Bringing it back",
					patch: [],
					send: () => setAsidePoEmail({ data: { id: e.id, aside: false } }),
				});
				return back ? "Back in emails to file" : null;
			},
		});
	}

	return (
		<li className="px-4 py-3">
			<div className="flex flex-wrap items-start gap-x-4 gap-y-2">
				<button
					type="button"
					onClick={() => setOpen(!open)}
					className="flex min-w-0 flex-1 items-start gap-1 text-left"
				>
					<ChevronRight
						className={cn(
							"mt-0.5 size-4 shrink-0 text-muted-foreground transition-transform",
							open && "rotate-90",
						)}
					/>
					<span className="min-w-0">
						<span className="block truncate">
							<span className="font-semibold">
								{e.fromName ?? e.fromAddress}
							</span>
							<span className="ml-2 text-xs text-muted-foreground">
								{formatDateTime(e.receivedAt)}
							</span>
						</span>
						<span className="block truncate">
							{e.subject || "(no subject)"}
						</span>
					</span>
				</button>
				<div className="flex flex-wrap items-center gap-1.5">
					{likely.slice(0, 3).map((p) => (
						<Button
							key={p.id}
							size="sm"
							variant="outline"
							onClick={() => file(p.id)}
						>
							PO {p.id}
						</Button>
					))}
					<select
						aria-label="File on a PO"
						value=""
						onChange={(x) => x.target.value && file(Number(x.target.value))}
						className="h-8 max-w-44 rounded-md border bg-background px-2 text-sm"
					>
						<option value="">
							{likely.length > 0 ? "Other PO" : "File on PO"}
						</option>
						{pos.map((p) => (
							<option key={p.id} value={p.id}>
								PO {p.id} · {p.supplier}
								{p.sentAt ? ` · ${formatDate(p.sentAt)}` : ""}
							</option>
						))}
					</select>
					<Button size="sm" variant="ghost" onClick={setAside}>
						Not a PO
					</Button>
				</div>
			</div>
			<div className="pl-5">
				<AttachmentChips attachments={e.attachments} />
				{open && (
					<p className="mt-2 max-h-80 overflow-y-auto rounded-md bg-muted/50 p-3 text-sm whitespace-pre-wrap">
						<span className="mb-2 block text-xs text-muted-foreground">
							{e.fromAddress}
						</span>
						{e.body || "(empty)"}
					</p>
				)}
			</div>
		</li>
	);
}
