import { ChevronRight, Paperclip, X } from "lucide-react";
import { useState } from "react";
import { Button } from "#/components/ui/button";
import { Tip } from "#/components/ui/tooltip";
import { optimism } from "#/lib/optimism";
import { offerUndo } from "#/lib/undo";
import { cn } from "#/lib/utils";
import { filePoEmail, type PurchaseOrderDetail } from "#/server/purchasing";
import { poData } from "./po-data";

type Email = PurchaseOrderDetail["emails"][number];

const kb = (bytes: number) =>
	bytes < 1_000_000
		? `${Math.max(1, Math.round(bytes / 1000))} KB`
		: `${(bytes / 1_000_000).toFixed(1)} MB`;

// Files open in a new tab; one too large to keep is named but not linked.
export function AttachmentChips({
	attachments,
}: {
	attachments: Email["attachments"];
}) {
	if (attachments.length === 0) return null;
	return (
		<span className="mt-1 flex flex-wrap gap-1.5">
			{attachments.map((a) =>
				a.kept ? (
					<a
						key={a.id}
						href={`/api/po-email-attachments/${a.id}`}
						target="_blank"
						rel="noreferrer"
						className="inline-flex max-w-64 items-center gap-1 rounded-md border px-1.5 py-0.5 text-xs hover:bg-muted"
					>
						<Paperclip className="size-3 shrink-0" />
						<span className="truncate">{a.filename}</span>
						<span className="text-muted-foreground">{kb(a.size)}</span>
					</a>
				) : (
					<Tip key={a.id} content="Too large to keep; it's in Outlook">
						<span className="inline-flex max-w-64 items-center gap-1 rounded-md border border-dashed px-1.5 py-0.5 text-xs text-muted-foreground">
							<Paperclip className="size-3 shrink-0" />
							<span className="truncate">{a.filename}</span>
						</span>
					</Tip>
				),
			)}
		</span>
	);
}

// An email on the PO's timeline: who and what, then the body on a click.
export function EmailEntry({ email: e, poId }: { email: Email; poId: number }) {
	const [open, setOpen] = useState(false);

	async function unfile() {
		const r = await optimism.change({
			label: "Taking the email off",
			patch: poData.patch(poId, (d) => ({
				...d,
				emails: d.emails.filter((x) => x.id !== e.id),
			})),
			send: () =>
				filePoEmail({ data: { emailId: e.id, purchaseOrderId: null } }),
		});
		if (!r) return;
		offerUndo("Email moved to Purchasing, to file", {
			undo: async () => {
				const back = await optimism.change({
					label: "Putting the email back",
					patch: [],
					send: () =>
						filePoEmail({ data: { emailId: e.id, purchaseOrderId: poId } }),
				});
				return back ? "Email back on the PO" : null;
			},
		});
	}

	return (
		<span className="group/email block">
			<button
				type="button"
				onClick={() => setOpen(!open)}
				className="flex max-w-full items-center gap-1 text-left"
			>
				<ChevronRight
					className={cn(
						"size-3.5 shrink-0 text-muted-foreground transition-transform",
						open && "rotate-90",
					)}
				/>
				<span className="truncate">
					<span className="font-semibold">{e.fromName ?? e.fromAddress}</span>:{" "}
					{e.subject || "(no subject)"}
				</span>
			</button>
			<AttachmentChips attachments={e.attachments} />
			{open && (
				<span className="mt-2 block rounded-md bg-muted/50 p-3">
					<span className="block text-xs text-muted-foreground">
						{e.fromAddress}
					</span>
					<span className="mt-2 block max-h-96 overflow-y-auto text-sm whitespace-pre-wrap">
						{e.body || "(empty)"}
					</span>
					<Button
						size="sm"
						variant="ghost"
						className="mt-2 -ml-2 text-muted-foreground"
						onClick={unfile}
					>
						<X />
						Not about this PO
					</Button>
				</span>
			)}
		</span>
	);
}
