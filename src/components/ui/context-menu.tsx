import { ContextMenu as ContextMenuPrimitive } from "radix-ui";
import type * as React from "react";
import { cn } from "#/lib/utils";

// Right-click menus, styled like the popovers.
const ContextMenu = ContextMenuPrimitive.Root;
const ContextMenuTrigger = ContextMenuPrimitive.Trigger;

function ContextMenuContent({
	className,
	...props
}: React.ComponentProps<typeof ContextMenuPrimitive.Content>) {
	return (
		<ContextMenuPrimitive.Portal>
			<ContextMenuPrimitive.Content
				className={cn(
					"z-50 min-w-56 rounded-xl bg-popover p-1 text-popover-foreground shadow-md outline-none ring-1 ring-black/5",
					className,
				)}
				{...props}
			/>
		</ContextMenuPrimitive.Portal>
	);
}

function ContextMenuItem({
	className,
	shortcut,
	children,
	...props
}: React.ComponentProps<typeof ContextMenuPrimitive.Item> & {
	shortcut?: string;
}) {
	return (
		<ContextMenuPrimitive.Item
			className={cn(
				"flex h-8 cursor-default items-center gap-2 rounded-lg px-2 outline-none select-none data-[disabled]:text-muted-foreground data-[highlighted]:bg-[#f1f1f1] [&_svg]:size-4 [&_svg]:shrink-0 [&_svg]:text-muted-foreground",
				className,
			)}
			{...props}
		>
			{children}
			{shortcut && (
				<kbd className="ml-auto pl-4 text-xs text-muted-foreground">
					{shortcut}
				</kbd>
			)}
		</ContextMenuPrimitive.Item>
	);
}

function ContextMenuSeparator({
	className,
	...props
}: React.ComponentProps<typeof ContextMenuPrimitive.Separator>) {
	return (
		<ContextMenuPrimitive.Separator
			className={cn("-mx-1 my-1 h-px bg-border", className)}
			{...props}
		/>
	);
}

export {
	ContextMenu,
	ContextMenuContent,
	ContextMenuItem,
	ContextMenuSeparator,
	ContextMenuTrigger,
};
