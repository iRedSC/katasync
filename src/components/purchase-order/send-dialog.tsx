import { useEffect, useState } from "react";
import { toast } from "sonner";
import {
	EmailComposer,
	type EmailEdit,
	type EmailPreview,
	useCloseGuard,
} from "#/components/email-composer";
import {
	Dialog,
	DialogContent,
	DialogHeader,
	DialogTitle,
} from "#/components/ui/dialog";
import { optimism } from "#/lib/optimism";
import {
	previewPurchaseOrderEmail,
	sendPurchaseOrder,
} from "#/server/purchasing";

// Shows the PO email as its template words it, to read and edit, then sends
// it with the PDF. The PO is on order once the email has gone.
export function SendDialog({
	purchaseOrderId,
	onClose,
}: {
	purchaseOrderId: number;
	onClose: () => void;
}) {
	const [preview, setPreview] = useState<EmailPreview | null>(null);
	const [sending, setSending] = useState(false);
	const guard = useCloseGuard();

	useEffect(() => {
		let live = true;
		previewPurchaseOrderEmail({ data: { id: purchaseOrderId } }).then(
			(p) => live && setPreview(p),
			(error: unknown) => {
				toast.error(error instanceof Error ? error.message : String(error));
				onClose();
			},
		);
		return () => {
			live = false;
		};
	}, [purchaseOrderId, onClose]);

	async function send(email: EmailEdit) {
		setSending(true);
		const r = await optimism.change({
			send: () => sendPurchaseOrder({ data: { id: purchaseOrderId, email } }),
		});
		setSending(false);
		if (!r) return;
		toast.success(`PO ${purchaseOrderId} emailed to ${r.value.sentTo}`);
		onClose();
	}

	return (
		<Dialog open onOpenChange={(open) => !open && !sending && onClose()}>
			<DialogContent className="sm:max-w-2xl" {...guard.contentProps}>
				<DialogHeader>
					<DialogTitle>Email PO {purchaseOrderId}</DialogTitle>
				</DialogHeader>
				{preview ? (
					<EmailComposer
						preview={preview}
						sending={sending}
						blocked={guard.blocked}
						onDirty={guard.setDirty}
						onSend={send}
						onCancel={onClose}
					/>
				) : (
					<div className="flex animate-pulse flex-col gap-3">
						<div className="h-4 w-48 rounded bg-muted" />
						<div className="h-9 rounded-lg bg-muted" />
						<div className="h-72 rounded-lg bg-muted" />
					</div>
				)}
			</DialogContent>
		</Dialog>
	);
}
