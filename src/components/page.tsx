import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import { Separator } from "#/components/ui/separator";
import { SidebarTrigger } from "#/components/ui/sidebar";

export function PageHeader({
	title,
	description,
	actions,
}: {
	title: string;
	description?: string;
	actions?: ReactNode;
}) {
	return (
		<header className="flex items-center gap-3 border-b px-4 py-3 md:px-6">
			<SidebarTrigger className="-ml-1" />
			<Separator orientation="vertical" className="h-5" />
			<div className="min-w-0 flex-1">
				<h1 className="truncate text-lg font-semibold">{title}</h1>
				{description && (
					<p className="truncate text-sm text-muted-foreground">
						{description}
					</p>
				)}
			</div>
			{actions && <div className="flex items-center gap-2">{actions}</div>}
		</header>
	);
}

export function PageBody({ children }: { children: ReactNode }) {
	return <div className="flex flex-col gap-6 p-4 md:p-6">{children}</div>;
}

// For features whose backend isn't built yet: says what will appear and why
// it's empty, instead of faking data.
export function EmptyState({
	icon: Icon,
	title,
	children,
}: {
	icon: LucideIcon;
	title: string;
	children: ReactNode;
}) {
	return (
		<div className="flex flex-col items-center justify-center gap-2 rounded-lg border border-dashed px-6 py-12 text-center">
			<div className="rounded-full bg-accent p-3 text-primary">
				<Icon className="size-5" />
			</div>
			<p className="font-medium">{title}</p>
			<div className="max-w-md text-sm text-muted-foreground">{children}</div>
		</div>
	);
}
