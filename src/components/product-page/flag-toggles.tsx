import { Tip } from "#/components/ui/tooltip";
import { optimism, optimistic } from "#/lib/optimism";
import { offerUndo } from "#/lib/undo";
import { cn } from "#/lib/utils";
import {
	type ProductDetail,
	setAerosol,
	setCritical,
	setInsureWhenShipped,
} from "#/server/catalog";

// The product page's data, patched under the same key as the page's own.
const productData = optimistic<ProductDetail>("product");

const insurePatch = (productId: number, insure: boolean) =>
	productData.patch(productId, (d) => ({
		...d,
		product: { ...d.product, insureWhenShipped: insure },
	}));

const aerosolPatch = (productId: number, aerosol: boolean) =>
	productData.patch(productId, (d) => ({
		...d,
		product: { ...d.product, aerosol },
	}));

const criticalPatch = (productId: number, critical: boolean) =>
	productData.patch(productId, (d) => ({
		...d,
		product: { ...d.product, critical },
	}));

export function InsureToggle({
	productId,
	sku,
	insure,
}: {
	productId: number;
	sku: string;
	insure: boolean;
}) {
	async function set(next: boolean) {
		const r = await optimism.change({
			label: `Insurance of ${sku}`,
			patch: insurePatch(productId, next),
			send: () => setInsureWhenShipped({ data: { sku, insure: next } }),
		});
		if (!r) return;
		offerUndo(next ? "Insured when shipped" : "No longer insured", {
			tone: "success",
			undo: async () => {
				const undone = await optimism.change({
					label: `Insurance of ${sku}`,
					patch: insurePatch(productId, !next),
					send: () => setInsureWhenShipped({ data: { sku, insure: !next } }),
				});
				return undone && (next ? "No longer insured" : "Insured when shipped");
			},
		});
	}
	return (
		<label className="flex cursor-pointer items-center gap-2">
			<input
				type="checkbox"
				checked={insure}
				onChange={(e) => set(e.target.checked)}
				className="size-4 accent-primary"
			/>
			Insure when shipped
		</label>
	);
}

// Quick ship starts boxes holding an aerosol as hazmat: ground services
// only, with the Limited Quantity mark printed after the label.
export function AerosolToggle({
	productId,
	sku,
	aerosol,
}: {
	productId: number;
	sku: string;
	aerosol: boolean;
}) {
	const said = (on: boolean) => (on ? "Ships as an aerosol" : "Not an aerosol");
	async function set(next: boolean) {
		const r = await optimism.change({
			label: `Aerosol flag of ${sku}`,
			patch: aerosolPatch(productId, next),
			send: () => setAerosol({ data: { sku, aerosol: next } }),
		});
		if (!r) return;
		offerUndo(said(next), {
			tone: "success",
			undo: async () => {
				const undone = await optimism.change({
					label: `Aerosol flag of ${sku}`,
					patch: aerosolPatch(productId, !next),
					send: () => setAerosol({ data: { sku, aerosol: !next } }),
				});
				return undone && said(!next);
			},
		});
	}
	return (
		<label
			className="flex cursor-pointer items-center gap-2"
			title="Quick ship marks its boxes hazmat: ground services only, Limited Quantity mark printed"
		>
			<input
				type="checkbox"
				checked={aerosol}
				onChange={(e) => set(e.target.checked)}
				className="size-4 accent-primary"
			/>
			Aerosol (hazmat)
		</label>
	);
}

// A items are critical already, so the box is checked and grayed out for
// them, with the reason on hover.
export function CriticalToggle({
	productId,
	sku,
	critical,
	isA,
}: {
	productId: number;
	sku: string;
	critical: boolean;
	isA: boolean;
}) {
	async function set(next: boolean) {
		const r = await optimism.change({
			label: `Essential flag of ${sku}`,
			patch: criticalPatch(productId, next),
			send: () => setCritical({ data: { productId, critical: next } }),
		});
		if (!r) return;
		offerUndo(next ? "Marked essential" : "No longer essential", {
			tone: "success",
			undo: async () => {
				const undone = await optimism.change({
					label: `Essential flag of ${sku}`,
					patch: criticalPatch(productId, !next),
					send: () => setCritical({ data: { productId, critical: !next } }),
				});
				return undone && (next ? "No longer essential" : "Marked essential");
			},
		});
	}
	return (
		<Tip content={isA ? "A items are always essential" : undefined}>
			<label
				className={cn(
					"flex items-center gap-2",
					isA ? "cursor-default text-muted-foreground" : "cursor-pointer",
				)}
			>
				<input
					type="checkbox"
					checked={critical || isA}
					disabled={isA}
					onChange={(e) => set(e.target.checked)}
					className="size-4 accent-primary"
				/>
				Essential
			</label>
		</Tip>
	);
}
