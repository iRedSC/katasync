import { ChevronRight } from "lucide-react";
import { ContextMenu as ContextMenuPrimitive } from "radix-ui";
import type * as React from "react";
import { cn } from "#/lib/utils";

// Right-click menus, styled like the popovers. An item's `shortcut` is a key
// that picks it while the menu is open, so a hint shown is always one that
// works. ↵ picks its item only when nothing is highlighted; otherwise Enter
// picks the highlighted item, as usual.
const ContextMenu = ContextMenuPrimitive.Root;
const ContextMenuTrigger = ContextMenuPrimitive.Trigger;

function pressShortcut(e: React.KeyboardEvent<HTMLDivElement>) {
	if (e.metaKey || e.ctrlKey || e.altKey) return;
	const key = e.key === "Enter" ? "↵" : e.key.toUpperCase();
	if (key === "↵" && e.currentTarget.querySelector("[data-highlighted]"))
		return;
	const item = [
		...e.currentTarget.querySelectorAll<HTMLElement>("[data-shortcut]"),
	].find((el) => el.dataset.shortcut === key);
	if (!item || item.hasAttribute("data-disabled")) return;
	e.preventDefault();
	item.click();
}

function ContextMenuContent({
	className,
	onKeyDown,
	...props
}: React.ComponentProps<typeof ContextMenuPrimitive.Content>) {
	return (
		<ContextMenuPrimitive.Portal>
			<ContextMenuPrimitive.Content
				onKeyDown={(e) => {
					onKeyDown?.(e);
					if (!e.defaultPrevented) pressShortcut(e);
				}}
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
			data-shortcut={shortcut?.toUpperCase()}
			className={cn(
				"flex h-8 cursor-default items-center gap-2 rounded-lg px-2 outline-none select-none data-[disabled]:text-muted-foreground data-[highlighted]:bg-surface [&_svg]:size-4 [&_svg]:shrink-0 [&_svg]:text-muted-foreground",
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

// A menu inside the menu, opened from its trigger row: hover, click, or →.
const ContextMenuSub = ContextMenuPrimitive.Sub;

function ContextMenuSubTrigger({
	className,
	children,
	...props
}: React.ComponentProps<typeof ContextMenuPrimitive.SubTrigger>) {
	return (
		<ContextMenuPrimitive.SubTrigger
			className={cn(
				"flex h-8 cursor-default items-center gap-2 rounded-lg px-2 outline-none select-none data-[disabled]:text-muted-foreground data-[highlighted]:bg-surface data-[state=open]:bg-surface [&_svg]:size-4 [&_svg]:shrink-0 [&_svg]:text-muted-foreground",
				className,
			)}
			{...props}
		>
			{children}
			<ChevronRight className="ml-auto" />
		</ContextMenuPrimitive.SubTrigger>
	);
}

function ContextMenuSubContent({
	className,
	...props
}: React.ComponentProps<typeof ContextMenuPrimitive.SubContent>) {
	return (
		<ContextMenuPrimitive.Portal>
			<ContextMenuPrimitive.SubContent
				className={cn(
					"z-50 min-w-44 rounded-xl bg-popover p-1 text-popover-foreground shadow-md outline-none ring-1 ring-black/5",
					className,
				)}
				{...props}
			/>
		</ContextMenuPrimitive.Portal>
	);
}

export {
	ContextMenu,
	ContextMenuContent,
	ContextMenuItem,
	ContextMenuSeparator,
	ContextMenuSub,
	ContextMenuSubContent,
	ContextMenuSubTrigger,
	ContextMenuTrigger,
};
