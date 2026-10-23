import { Link } from "@tanstack/react-router";
import { useRef, useState } from "react";
import { shake } from "#/components/shake";
import { SupplierCatalogs } from "#/components/supplier-catalogs";
import { type Supplier, SupplierForm } from "#/components/supplier-form";
import {
	Dialog,
	DialogContent,
	DialogHeader,
	DialogTitle,
} from "#/components/ui/dialog";
import type { Patch } from "#/lib/optimism";
import type { LeadTime } from "#/purchasing/forecast";

// Edits a supplier's details without leaving the page, e.g. from a PO. With
// unsaved changes, clicking outside doesn't close it, so a stray click can't
// lose them; it shakes and says why instead. Cancel or Esc still close it.
// `patch` shows the saved details on the page at once; without it the page
// shows them once reloaded.
export function SupplierDialog({
	supplier,
	leadTime,
	open,
	onOpenChange,
	patch,
}: {
	supplier: Supplier;
	// What reorder plans on, so the form can say when it isn't the typed one.
	leadTime: LeadTime;
	open: boolean;
	onOpenChange: (open: boolean) => void;
	patch?: (saved: Supplier) => Patch;
}) {
	const [dirty, setDirty] = useState(false);
	const [blocked, setBlocked] = useState(false);
	const content = useRef<HTMLDivElement>(null);
	const change = (open: boolean) => {
		if (!open) {
			setDirty(false);
			setBlocked(false);
		}
		onOpenChange(open);
	};
	return (
		<Dialog open={open} onOpenChange={change}>
			<DialogContent
				showCloseButton={false}
				ref={content}
				onInteractOutside={(e) => {
					if (!dirty) return;
					e.preventDefault();
					setBlocked(true);
					shake(content.current);
				}}
				onEscapeKeyDown={(e) => {
					// Esc closes an open address suggestion list first.
					if (
						e.target instanceof HTMLElement &&
						e.target.getAttribute("aria-expanded") === "true"
					)
						e.preventDefault();
				}}
				className="max-h-[90dvh] overflow-y-auto sm:max-w-2xl"
			>
				<DialogHeader className="flex-row items-baseline justify-between gap-4">
					<DialogTitle>{supplier.name}</DialogTitle>
					<Link
						to="/purchasing/suppliers/$id"
						params={{ id: String(supplier.id) }}
						className="text-sm text-link hover:underline"
					>
						Supplier page
					</Link>
				</DialogHeader>
				{open && <SupplierCatalogs supplier={supplier} />}
				<SupplierForm
					// Fresh fields each time it opens.
					key={String(open)}
					s={supplier}
					leadTime={leadTime}
					onDirty={(d) => {
						setDirty(d);
						if (!d) setBlocked(false);
					}}
					blocked={blocked}
					onDone={() => change(false)}
					patch={patch}
				/>
			</DialogContent>
		</Dialog>
	);
}
