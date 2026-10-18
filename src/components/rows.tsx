import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import { Button } from "#/components/ui/button";
import { Tip } from "#/components/ui/tooltip";

// A card's list of things, each with its actions in fixed slots on the
// right so they line up down the list; pass <ActionSlot /> for one a row
// doesn't have.
export function Row({
	children,
	actions,
}: {
	children: ReactNode;
	actions?: ReactNode;
}) {
	return (
		<li className="flex min-h-12 items-center gap-3 border-t px-4 py-2">
			<div className="flex min-w-0 flex-1 items-center gap-3">{children}</div>
			{actions && <div className="flex shrink-0 gap-1">{actions}</div>}
		</li>
	);
}

export function IconAction({
	icon: Icon,
	label,
	tip,
	disabled,
	onClick,
}: {
	icon: LucideIcon;
	label: string;
	// Shown instead of the label, e.g. why it's disabled.
	tip?: string;
	disabled?: boolean;
	onClick: () => void;
}) {
	return (
		<Tip content={tip ?? label}>
			<Button
				variant="ghost"
				size="icon-sm"
				aria-label={label}
				disabled={disabled}
				onClick={onClick}
			>
				<Icon />
			</Button>
		</Tip>
	);
}

export function ActionSlot() {
	return <span className="size-8" />;
}
