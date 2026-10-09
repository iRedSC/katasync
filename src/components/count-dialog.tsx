import { useRouter } from "@tanstack/react-router";
import { type FormEvent, useState } from "react";
import { Button } from "#/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "#/components/ui/dialog";
import { formatCount, formatDelta } from "#/lib/format";
import { cn } from "#/lib/utils";
import { recordCount } from "#/server/catalog";

const reasons = [
	{ value: "count", label: "Counted" },
	{ value: "damaged", label: "Damaged" },
	{ value: "found", label: "Found more" },
	{ value: "other", label: "Other" },
] as const;

// Type what's on the shelf; the app works out the change. Location is only
// asked for when there's more than one.
export function CountDialog({
	open,
	onOpenChange,
	sku,
	name,
	locations,
	onHandByLocation,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	sku: string;
	name: string;
	locations: { id: number; name: string }[];
	onHandByLocation: Map<string, number>;
}) {
	const router = useRouter();
	const [locationId, setLocationId] = useState(locations[0]?.id);
	const location = locations.find((l) => l.id === locationId);
	const current = onHandByLocation.get(location?.name ?? "") ?? 0;
	const [counted, setCounted] = useState("");
	const [reason, setReason] =
		useState<(typeof reasons)[number]["value"]>("count");
	const [error, setError] = useState<string | null>(null);
	const [saving, setSaving] = useState(false);

	const value = counted === "" ? null : Number(counted);
	const delta =
		value === null || !Number.isInteger(value) ? null : value - current;

	async function submit(e: FormEvent) {
		e.preventDefault();
		if (value === null || !Number.isInteger(value)) return;
		setSaving(true);
		setError(null);
		try {
			await recordCount({ data: { sku, counted: value, reason, locationId } });
			onOpenChange(false);
			setCounted("");
			await router.invalidate();
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			setSaving(false);
		}
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
						<p className="text-sm text-muted-foreground">
							{delta === null ? (
								<>We think there are {formatCount(current)}</>
							) : delta === 0 ? (
								<>Matches what we think. Nothing to change.</>
							) : (
								<>
									<span
										className={cn(
											"font-semibold tabular-nums",
											delta < 0 ? "text-bad" : "text-good",
										)}
									>
										{formatDelta(delta)}
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

					{error && <p className="text-center text-sm text-bad">{error}</p>}
					<DialogFooter>
						<Button
							type="submit"
							size="lg"
							className="w-full"
							disabled={delta === null || delta === 0 || saving}
						>
							Save count
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
				"rounded-full border px-3 py-1 text-sm transition-colors",
				active
					? "border-foreground bg-foreground text-background"
					: "hover:bg-accent",
			)}
		>
			{children}
		</button>
	);
}
