import {
	Link,
	type LinkProps,
	useCanGoBack,
	useNavigate,
	useRouter,
} from "@tanstack/react-router";
import { ArrowLeft, type LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import { Tip } from "#/components/ui/tooltip";
import { cn } from "#/lib/utils";

// Building blocks: Page, Card, Badge. There's no page-wide banner: a problem
// shows on the thing it's about (a card's header, a row, a button's tip).

// Going back returns to wherever the user came from (a PO, a filtered list),
// as it was. `fallback` is only for a page opened fresh, with nothing before
// it in the app.
export function useBack(fallback: LinkProps) {
	const router = useRouter();
	const navigate = useNavigate();
	const canGoBack = useCanGoBack();
	return () => (canGoBack ? router.history.back() : navigate(fallback));
}

export function Page({
	title,
	back,
	actions,
	width,
	children,
}: {
	title: ReactNode;
	// Where the arrow goes when there's no history to go back through.
	back?: LinkProps;
	actions?: ReactNode;
	// Narrow for forms and single records, wide for big tables.
	width?: "narrow" | "wide";
	children: ReactNode;
}) {
	return (
		<div
			className={cn(
				"mx-auto flex w-full flex-col gap-4 px-4 py-5 md:px-6",
				width === "narrow"
					? "max-w-[62rem]"
					: width === "wide"
						? "max-w-[100rem]"
						: "max-w-[75rem]",
			)}
		>
			<header className="flex min-h-9 items-center gap-2">
				{back && <BackLink fallback={back} />}
				<h1 className="min-w-0 flex-1 truncate text-xl font-bold">{title}</h1>
				{actions && <div className="flex items-center gap-2">{actions}</div>}
			</header>
			{children}
		</div>
	);
}

// A real link to the fallback, so it still opens in a new tab, but a plain
// click goes back through history instead.
function BackLink({ fallback }: { fallback: LinkProps }) {
	const goBack = useBack(fallback);
	return (
		<Link
			{...fallback}
			onClick={(e) => {
				if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
				e.preventDefault();
				goBack();
			}}
			className="rounded-lg p-1.5 text-muted-foreground hover:bg-surface-strong"
			aria-label="Back"
		>
			<ArrowLeft className="size-4" />
		</Link>
	);
}

const headerTones = {
	warning: "bg-warning-surface text-warning-text",
	critical: "bg-critical-surface text-critical-text",
};

export function Card({
	title,
	aside,
	flush = false,
	tone,
	className,
	children,
}: {
	title?: ReactNode;
	aside?: ReactNode;
	// Flush cards let tables and lists run edge to edge.
	flush?: boolean;
	// Tints the header, to flag what the aside says.
	tone?: "warning" | "critical";
	className?: string;
	children: ReactNode;
}) {
	return (
		<section
			className={cn(
				"overflow-hidden rounded-xl bg-card shadow-card",
				!flush && "p-4",
				className,
			)}
		>
			{title && (
				<div
					className={cn(
						"flex items-center justify-between gap-4",
						flush ? "px-4 pt-4 pb-2" : "pb-3",
						tone &&
							(flush
								? cn("pb-4", headerTones[tone])
								: cn("-mx-4 -mt-4 mb-3 p-4", headerTones[tone])),
					)}
				>
					<h2 className="text-sm font-semibold">{title}</h2>
					{aside && (
						<div className={tone ? "font-medium" : "text-muted-foreground"}>
							{aside}
						</div>
					)}
				</div>
			)}
			{children}
		</section>
	);
}

export type Tone = "critical" | "warning" | "success" | "info";

const tones: Record<Tone, { fill: string; text: string }> = {
	critical: { fill: "bg-critical-fill", text: "text-critical-text" },
	warning: { fill: "bg-warning-fill", text: "text-warning-text" },
	success: { fill: "bg-success-fill", text: "text-success-text" },
	info: { fill: "bg-info-fill", text: "text-info-text" },
};

// A status pill. The words carry the meaning; color helps scanning.
export function Badge({
	tone,
	children,
}: {
	tone?: Tone;
	children: ReactNode;
}) {
	return (
		<span
			className={cn(
				"inline-flex h-5 shrink-0 items-center rounded-md px-2 text-xs font-medium whitespace-nowrap",
				tone
					? cn(tones[tone].fill, tones[tone].text)
					: "bg-surface-strong text-foreground",
			)}
		>
			{children}
		</span>
	);
}

const abcColors = {
	A: "bg-abc-a-fill text-abc-a-text",
	B: "bg-abc-b-fill text-abc-b-text",
	C: "bg-abc-c-fill text-abc-c-text",
} as const;

// A product's ABC class. Products that can't be classed show a dash.
export function AbcBadge({
	abc,
	title,
}: {
	abc: "A" | "B" | "C" | null;
	title?: string;
}) {
	if (abc === null) {
		return (
			<Tip content={title}>
				<span className="text-muted-foreground">—</span>
			</Tip>
		);
	}
	return (
		<Tip content={title}>
			<span
				className={cn(
					"inline-flex h-5 w-6 shrink-0 items-center justify-center rounded-md text-xs font-semibold",
					abcColors[abc],
				)}
			>
				{abc}
			</span>
		</Tip>
	);
}

// For features whose backend isn't built yet.
export function EmptyState({
	icon: Icon,
	title,
	children,
}: {
	icon: LucideIcon;
	title: string;
	children?: ReactNode;
}) {
	return (
		<div className="flex flex-col items-center justify-center gap-2 px-6 py-16 text-center">
			<Icon className="size-10 text-faint" strokeWidth={1.5} />
			<p className="text-base font-semibold">{title}</p>
			{children && (
				<div className="max-w-sm text-muted-foreground">{children}</div>
			)}
		</div>
	);
}
