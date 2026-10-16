import NumberFlow from "@number-flow/react";
import { type FormEvent, useState } from "react";
import { toast } from "sonner";
import { Button } from "#/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "#/components/ui/dialog";
import { formatCount } from "#/lib/format";
import { optimism, type Patch } from "#/lib/optimism";
import { offerUndo } from "#/lib/undo";
import { cn } from "#/lib/utils";
import { recordCount, undoMovement } from "#/server/catalog";

const reasons = [
	{ value: "count", label: "Counted" },
	{ value: "damaged", label: "Damaged" },
	{ value: "found", label: "Found more" },
	{ value: "other", label: "Other" },
] as const;

// Type what's on the shelf; the app works out the change. Location is only
// asked for when there's more than one. `patch` says how a count shows on the
// page it's on, and what undoing it shows; with it the dialog closes at once.
// Without it, the dialog waits for the server.
export function CountDialog({
	open,
	onOpenChange,
	sku,
	name,
	locations,
	onHandByLocation,
	patch,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	sku: string;
	name: string;
	locations: { id: number; name: string }[];
	onHandByLocation: Map<string, number>;
	patch?: (count: { location: string; counted: number; previous: number }) => {
		patch: Patch;
		undo: Patch;
	};
}) {
	const [locationId, setLocationId] = useState(locations[0]?.id);
	const location = locations.find((l) => l.id === locationId);
	const current = onHandByLocation.get(location?.name ?? "") ?? 0;
	const [counted, setCounted] = useState("");
	const [reason, setReason] =
		useState<(typeof reasons)[number]["value"]>("count");
	const [saving, setSaving] = useState(false);

	const value = counted === "" ? null : Number(counted);
	const delta =
		value === null || !Number.isInteger(value) ? null : value - current;

	// Labelled with what it is, e.g. "Count of Widget didn't save".
	function change<T>(laid: Patch | undefined, send: () => Promise<T>) {
		return optimism.change(
			laid ? { label: `Count of ${name}`, patch: laid, send } : { send },
		);
	}

	async function submit(e: FormEvent) {
		e.preventDefault();
		if (value === null || !Number.isInteger(value)) return;
		const laid =
			location &&
			patch?.({ location: location.name, counted: value, previous: current });
		const close = () => {
			onOpenChange(false);
			setCounted("");
		};
		// A count that shows at once closes now; otherwise the dialog waits.
		if (laid) close();
		else setSaving(true);
		const r = await change(laid?.patch, () =>
			recordCount({ data: { sku, counted: value, reason, locationId } }),
		);
		setSaving(false);
		if (!r) return;
		if (!laid) close();
		const { batchId } = r.value;
		if (!batchId) {
			toast.success("Count confirmed. Nothing changed.", { description: name });
			return;
		}
		offerUndo(`Count saved. ${formatCount(r.value.onHand)} on the shelf.`, {
			tone: "success",
			description: name,
			undo: async () => {
				const undone = await change(laid?.undo, () =>
					undoMovement({ data: { batchId } }),
				);
				return undone && `Count of ${name} undone`;
			},
		});
	}

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="sm:max-w-md">
				<form onSubmit={submit} className="flex flex-col gap-6">
					<DialogHeader>
						<DialogTitle>How many are on the shelf?</DialogTitle>
						<DialogDescription className="truncate">{name}</DialogDescription>
					</DialogHeader>

					{locations.length > 1 && (
						<div className="flex flex-wrap gap-2">
							{locations.map((l) => (
								<Chip
									key={l.id}
									active={l.id === locationId}
									onClick={() => setLocationId(l.id)}
								>
									{l.name}
								</Chip>
							))}
						</div>
					)}

					<div className="flex flex-col items-center gap-2">
						<input
							autoFocus
							inputMode="numeric"
							value={counted}
							onChange={(e) =>
								setCounted(e.target.value.replace(/[^\d-]/g, ""))
							}
							placeholder={String(current)}
							className="w-full bg-transparent text-center text-6xl font-semibold tabular-nums outline-none placeholder:text-muted-foreground/30"
						/>
						<p className="text-muted-foreground">
							{delta === null ? (
								<>We think there are {formatCount(current)}</>
							) : delta === 0 ? (
								<>Matches what we think. Saving marks it counted.</>
							) : (
								<>
									<span
										className={cn(
											"font-semibold tabular-nums",
											delta < 0 ? "text-critical-text" : "text-success-text",
										)}
									>
										<NumberFlow
											value={delta}
											format={{ signDisplay: "always" }}
										/>
									</span>{" "}
									from the {formatCount(current)} we think there are
								</>
							)}
						</p>
					</div>

					<div className="flex flex-wrap justify-center gap-2">
						{reasons.map((r) => (
							<Chip
								key={r.value}
								active={r.value === reason}
								onClick={() => setReason(r.value)}
							>
								{r.label}
							</Chip>
						))}
					</div>

					<DialogFooter>
						<Button
							type="submit"
							size="lg"
							className="w-full"
							disabled={delta === null || saving}
						>
							{delta === 0 ? "Confirm count" : "Save count"}
						</Button>
					</DialogFooter>
				</form>
			</DialogContent>
		</Dialog>
	);
}

function Chip({
	active,
	onClick,
	children,
}: {
	active: boolean;
	onClick: () => void;
	children: React.ReactNode;
}) {
	return (
		<button
			type="button"
			onClick={onClick}
			className={cn(
				"h-7 rounded-lg px-3 font-medium transition-colors",
				active
					? "bg-primary text-primary-foreground"
					: "bg-surface hover:bg-surface-strong",
			)}
		>
			{children}
		</button>
	);
}
