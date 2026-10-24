import { Link, useRouter } from "@tanstack/react-router";
import { ExternalLink, Tag } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { Card } from "#/components/page";
import { type RefurbChoice, RefurbishForm } from "#/components/refurbish-form";
import { Button } from "#/components/ui/button";
import { Dialog, DialogContent } from "#/components/ui/dialog";
import { formatMoney } from "#/lib/format";
import { optimism } from "#/lib/optimism";
import { printPdf } from "#/printing/qz-client";
import { getBenchListing, listBenchJob } from "#/server/bench";
import type { Detail } from "./repair-data";

// A bench job's side of its page: where the unit came from, and listing it
// as a refurb once it's fixed (src/repairs/bench.ts).

export function SourceCard({ d }: { d: Detail }) {
	const r = d.repair;
	return (
		<Card title="Refurb">
			{r.returnOrderId !== null ? (
				<Link
					to="/orders/$id"
					params={{ id: String(r.returnOrderId) }}
					className="text-link"
				>
					Returned on {r.returnOrderName}
				</Link>
			) : (
				<span className="text-muted-foreground">
					Not from a return: listing adds it to stock
				</span>
			)}
		</Card>
	);
}

// Listing it: the refurb's form, as for a return, then its box label.
export function ListBenchCard({
	d,
	editable,
}: {
	d: Detail;
	editable: boolean;
}) {
	const r = d.repair;
	const router = useRouter();
	const [open, setOpen] = useState(false);
	const known = d.parts.every((p) => p.unitCost !== null);
	const partsCost = d.parts.reduce(
		(n, p) => n + (p.unitCost ?? 0) * p.quantity,
		0,
	);

	async function list(choice: RefurbChoice) {
		setOpen(false);
		const as =
			choice.kind === "add"
				? { kind: "add" as const, productId: choice.productId }
				: choice;
		const done = await optimism.change({
			send: () => listBenchJob({ data: { id: r.id, as } }),
		});
		if (!done) return;
		void printPdf(`/labels/bench/${r.id}`, "Box label");
		void router.invalidate();
		const { sku, shopifyUrl } = done.value;
		toast.success(`R${r.id} listed as ${sku}`, {
			description: shopifyUrl && (
				<a
					href={shopifyUrl}
					target="_blank"
					rel="noreferrer"
					className="inline-flex items-center gap-1 text-link underline"
				>
					Add photos and publish
					<ExternalLink className="size-3" />
				</a>
			),
		});
	}

	if (r.refurbSku)
		return (
			<Card title="Listed">
				<Link
					to="/products/$sku"
					params={{ sku: r.refurbSku }}
					className="font-semibold text-link"
				>
					{r.refurbSku}
				</Link>
			</Card>
		);
	return (
		<Card title="List it">
			{d.parts.length > 0 && (
				<div className="mb-3 flex justify-between text-muted-foreground">
					<span>Parts, added to its cost</span>
					<span className="tabular-nums">
						{known ? formatMoney(partsCost) : "Unknown"}
					</span>
				</div>
			)}
			<Button
				className="w-full"
				disabled={!editable}
				onClick={() => setOpen(true)}
			>
				<Tag />
				List as refurb
			</Button>
			<Dialog open={open} onOpenChange={setOpen}>
				<DialogContent className="sm:max-w-xl">
					{open && (
						<RefurbishForm
							load={() => getBenchListing({ data: { id: r.id } })}
							loadKey={`bench:${r.id}`}
							quantity={1}
							name={r.tool}
							onBack={() => setOpen(false)}
							onChoose={list}
						/>
					)}
				</DialogContent>
			</Dialog>
		</Card>
	);
}
