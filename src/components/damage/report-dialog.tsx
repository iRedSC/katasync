import { Mail } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import {
	EmailComposer,
	type EmailEdit,
	type EmailPreview,
	useCloseGuard,
} from "#/components/email-composer";
import { Button } from "#/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "#/components/ui/dialog";
import { Tip } from "#/components/ui/tooltip";
import { optimism } from "#/lib/optimism";
import { cn } from "#/lib/utils";
import { EMAIL_PHOTO_BYTES } from "#/purchasing/damage-limits";
import {
	type PurchaseOrderDetail,
	previewDamageReport,
	sendPurchaseDamageReport,
} from "#/server/purchasing";

type Damage = PurchaseOrderDetail["damages"][number];
type Remedy = "credit" | "replacement";

const productName = (d: Pick<Damage, "name" | "variantName">) =>
	d.variantName ? `${d.name} (${d.variantName})` : d.name;

// Emails the supplier every damage not yet reported, with its photos. Each
// one needs credit or replacement chosen first; nothing is picked for you,
// since a replacement makes the PO wait for more. Then the email, to read
// and edit; Back keeps the choices. Sending stays in the dialog until the
// email has gone.
export function DamageReportDialog({
	detail: d,
	damages,
	onClose,
}: {
	detail: PurchaseOrderDetail;
	// The ones not yet reported.
	damages: Damage[];
	onClose: () => void;
}) {
	const [remedies, setRemedies] = useState(new Map<number, Remedy>());
	const [sending, setSending] = useState(false);
	const [preview, setPreview] = useState<EmailPreview | null>(null);
	const guard = useCloseGuard();
	const unchosen = damages.filter((x) => !remedies.has(x.id)).length;
	const to = d.supplier.email;
	const photoBytes = damages.reduce((n, x) => n + x.photoBytes, 0);
	const why = !d.emailConfigured
		? "Email isn't set up here (RESEND_API_KEY and PO_EMAIL_FROM)"
		: !to
			? `${d.supplier.name} has no email. Add one under Supplier.`
			: photoBytes > EMAIL_PHOTO_BYTES
				? `The photos come to ${Math.round(photoBytes / 1_000_000)} MB, more than one email takes. Remove some under Received.`
				: unchosen > 0
					? `Choose credit or replacement for ${unchosen === damages.length ? "each" : `${unchosen} more`}`
					: null;
	const replacing = damages.filter((x) => remedies.get(x.id) === "replacement");

	const chosen = () =>
		[...remedies].map(([damageId, remedy]) => ({ damageId, remedy }));

	// The email, worded by its template, to read and edit before it goes.
	async function review() {
		setSending(true);
		try {
			setPreview(
				await previewDamageReport({
					data: { purchaseOrderId: d.order.id, remedies: chosen() },
				}),
			);
		} catch (error) {
			toast.error(error instanceof Error ? error.message : String(error));
		}
		setSending(false);
	}

	async function send(email: EmailEdit) {
		setSending(true);
		const r = await optimism.change({
			send: () =>
				sendPurchaseDamageReport({
					data: { purchaseOrderId: d.order.id, remedies: chosen(), ...email },
				}),
		});
		setSending(false);
		if (!r) return;
		toast.success(`Damage report emailed to ${r.value.sentTo}`);
		onClose();
	}

	if (preview)
		return (
			<Dialog open onOpenChange={(open) => !open && !sending && onClose()}>
				<DialogContent className="sm:max-w-2xl" {...guard.contentProps}>
					<DialogHeader>
						<DialogTitle>Damage report</DialogTitle>
					</DialogHeader>
					<EmailComposer
						preview={preview}
						sending={sending}
						blocked={guard.blocked}
						onDirty={guard.setDirty}
						onSend={send}
						cancelLabel="Back"
						onCancel={() => {
							guard.setDirty(false);
							setPreview(null);
						}}
					/>
				</DialogContent>
			</Dialog>
		);

	return (
		<Dialog open onOpenChange={(open) => !open && !sending && onClose()}>
			<DialogContent className="sm:max-w-2xl">
				<DialogHeader>
					<DialogTitle>Damage report</DialogTitle>
					<DialogDescription>
						{to
							? `To ${to}, with every photo attached.`
							: "Goes to the supplier by email, with every photo attached."}
					</DialogDescription>
				</DialogHeader>

				<ul className="flex max-h-[60svh] flex-col divide-y overflow-y-auto">
					{damages.map((x) => {
						const chosen = remedies.get(x.id);
						return (
							<li key={x.id} className="flex items-start gap-3 py-3">
								<div className="flex shrink-0 gap-1">
									{x.photoIds.slice(0, 2).map((id) => (
										<img
											key={id}
											src={`/purchasing/damage-photo/${id}`}
											alt=""
											className="size-12 rounded-md bg-surface-strong object-cover"
										/>
									))}
									{x.photoIds.length === 0 && (
										<div className="flex size-12 items-center justify-center rounded-md bg-subtle text-center text-[0.625rem] leading-tight text-muted-foreground">
											No photo
										</div>
									)}
								</div>
								<div className="min-w-0 flex-1">
									<p className="font-medium">
										{x.quantity} × {productName(x)}
									</p>
									<p className="text-sm text-muted-foreground">
										{x.description}
										{x.photoIds.length > 2 && ` · ${x.photoIds.length} photos`}
									</p>
								</div>
								<fieldset
									aria-label={`What to ask for ${x.sku}`}
									className="flex shrink-0 rounded-lg border-0 bg-subtle p-0.5 text-sm font-semibold"
								>
									{(["credit", "replacement"] as const).map((remedy) => {
										const off = remedy === "replacement" && !x.replaceable;
										return (
											<Tip
												key={remedy}
												content={
													off
														? `${x.quantity} isn't a whole ${x.unit} of ${x.packSize}, so the PO can't expect a replacement`
														: undefined
												}
											>
												<button
													type="button"
													aria-pressed={chosen === remedy}
													disabled={sending || off}
													onClick={() =>
														setRemedies(new Map(remedies).set(x.id, remedy))
													}
													className={cn(
														"rounded-md px-3 py-1.5 disabled:opacity-40",
														chosen === remedy
															? "bg-white shadow-card"
															: "text-muted-foreground hover:text-foreground",
													)}
												>
													{remedy === "credit" ? "Credit" : "Replacement"}
												</button>
											</Tip>
										);
									})}
								</fieldset>
							</li>
						);
					})}
				</ul>

				{replacing.length > 0 && (
					<p className="text-sm text-muted-foreground">
						The PO will wait for{" "}
						{replacing
							.map(
								(x) =>
									`${x.quantity / x.packSize}${x.packSize === 1 ? "" : ` ${x.unit}`} × ${x.sku}`,
							)
							.join(", ")}{" "}
						more.
					</p>
				)}

				<DialogFooter className="items-center gap-2">
					{why && (
						<p className="text-sm text-muted-foreground sm:mr-auto">{why}</p>
					)}
					<Button variant="outline" disabled={sending} onClick={onClose}>
						Cancel
					</Button>
					<Button disabled={Boolean(why) || sending} onClick={review}>
						<Mail />
						Review email
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
