import { Tooltip as TooltipPrimitive } from "radix-ui";
import * as React from "react";
import { cn } from "#/lib/utils";

// The app's only tooltip, a dark bubble like the toasts. Native `title` attributes are banned by
// tooltip.test.ts; wrap the element in <Tip> instead.

function TooltipProvider(
	props: React.ComponentProps<typeof TooltipPrimitive.Provider>,
) {
	return (
		<TooltipPrimitive.Provider
			delayDuration={250}
			skipDelayDuration={300}
			{...props}
		/>
	);
}

// Shows `content` on hover or keyboard focus of its one child. Nothing to
// say (undefined, null, "") just never opens, so conditional tips need no
// branching at the call site and the child isn't remounted when the tip
// comes and goes. A disabled child gets no pointer events, so it's wrapped
// in a span that can still be hovered. Other props (e.g. from a parent
// PopoverTrigger asChild) pass through to the child.
function Tip({
	content,
	side = "top",
	align = "center",
	className,
	children,
	...trigger
}: {
	content: React.ReactNode;
	side?: React.ComponentProps<typeof TooltipPrimitive.Content>["side"];
	align?: React.ComponentProps<typeof TooltipPrimitive.Content>["align"];
	className?: string;
	children: React.ReactElement;
} & Omit<
	React.ComponentProps<typeof TooltipPrimitive.Trigger>,
	"asChild" | "content" | "children" | "className" | "title"
>) {
	const [open, setOpen] = React.useState(false);
	const empty = content === undefined || content === null || content === "";
	const disabled =
		!empty &&
		React.isValidElement<{ disabled?: unknown }>(children) &&
		Boolean(children.props.disabled);
	return (
		<TooltipPrimitive.Root open={open && !empty} onOpenChange={setOpen}>
			<TooltipPrimitive.Trigger asChild {...trigger}>
				{disabled ? (
					// Focusable so keyboard users can reach why it is disabled.
					<span tabIndex={0} className="inline-flex">
						{children}
					</span>
				) : (
					children
				)}
			</TooltipPrimitive.Trigger>
			<TooltipPrimitive.Portal>
				<TooltipPrimitive.Content
					side={side}
					align={align}
					sideOffset={6}
					collisionPadding={8}
					className={cn(
						"z-50 max-w-72 rounded-md bg-topbar px-2.5 py-1.5 text-left text-xs leading-snug font-normal text-balance text-white shadow-lg",
						"origin-(--radix-tooltip-content-transform-origin) animate-in fade-in-0 zoom-in-95 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95",
						className,
					)}
				>
					{content}
					<TooltipPrimitive.Arrow className="fill-topbar" />
				</TooltipPrimitive.Content>
			</TooltipPrimitive.Portal>
		</TooltipPrimitive.Root>
	);
}

export { Tip, TooltipProvider };
