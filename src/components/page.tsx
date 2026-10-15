import { Link, type LinkProps } from "@tanstack/react-router";
import {
	AlertCircle,
	AlertTriangle,
	ArrowLeft,
	CheckCircle2,
	Info,
	type LucideIcon,
} from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "#/lib/utils";

// Polaris-style building blocks: Page, Card, Banner, Badge.

export function Page({
	title,
	back,
	actions,
	width,
	children,
}: {
	title: ReactNode;
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
				{back && (
					<Link
						{...back}
						className="rounded-lg p-1.5 text-[#4a4a4a] hover:bg-[#e3e3e3]"
						aria-label="Back"
					>
						<ArrowLeft className="size-4" />
					</Link>
				)}
				<h1 className="min-w-0 flex-1 truncate text-xl font-bold">{title}</h1>
				{actions && <div className="flex items-center gap-2">{actions}</div>}
			</header>
			{children}
		</div>
	);
}

export function Card({
	title,
	aside,
	flush = false,
	className,
	children,
}: {
	title?: ReactNode;
	aside?: ReactNode;
	// Flush cards let tables and lists run edge to edge.
	flush?: boolean;
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
					)}
				>
					<h2 className="text-sm font-semibold">{title}</h2>
					{aside && <div className="text-muted-foreground">{aside}</div>}
				</div>
			)}
			{children}
		</section>
	);
}

export type Tone = "critical" | "warning" | "success" | "info";

const tones: Record<
	Tone,
	{
		icon: LucideIcon;
		surface: string;
		fill: string;
		text: string;
		iconColor: string;
		border: string;
	}
> = {
	critical: {
		icon: AlertCircle,
		surface: "bg-critical-surface",
		fill: "bg-critical-fill",
		text: "text-critical-text",
		iconColor: "text-critical-icon",
		border: "border-critical-border",
	},
	warning: {
		icon: AlertTriangle,
		surface: "bg-warning-surface",
		fill: "bg-warning-fill",
		text: "text-warning-text",
		iconColor: "text-warning-icon",
		border: "border-warning-border",
	},
	success: {
		icon: CheckCircle2,
		surface: "bg-success-surface",
		fill: "bg-success-fill",
		text: "text-success-text",
		iconColor: "text-success-icon",
		border: "border-success-border",
	},
	info: {
		icon: Info,
		surface: "bg-info-surface",
		fill: "bg-info-fill",
		text: "text-info-text",
		iconColor: "text-info-icon",
		border: "border-info-border",
	},
};

// A problem worth acting on, like Polaris's Banner. The icon and title say
// what the color means.
export function Banner({
	tone,
	title,
	children,
	action,
}: {
	tone: Tone;
	title: ReactNode;
	children?: ReactNode;
	action?: { label: string; link: LinkProps };
}) {
	const t = tones[tone];
	return (
		<div
			className={cn(
				"flex gap-3 rounded-xl border p-3 pr-4",
				t.surface,
				t.border,
			)}
		>
			<t.icon className={cn("mt-0.5 size-5 shrink-0", t.iconColor)} />
			<div className="flex min-w-0 flex-1 flex-col gap-1">
				<p className="font-semibold">{title}</p>
				{children && <div>{children}</div>}
				{action && (
					<div className="pt-1">
						<Link
							{...action.link}
							className="inline-flex h-7 items-center rounded-lg bg-white px-3 font-medium shadow-card hover:bg-[#f7f7f7]"
						>
							{action.label}
						</Link>
					</div>
				)}
			</div>
		</div>
	);
}

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
				"inline-flex h-5 shrink-0 items-center rounded-lg px-2 text-xs font-medium whitespace-nowrap",
				tone
					? cn(tones[tone].fill, tones[tone].text)
					: "bg-[#e3e3e3] text-[#303030]",
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
			<span className="text-muted-foreground" title={title}>
				—
			</span>
		);
	}
	return (
		<span
			title={title}
			className={cn(
				"inline-flex h-5 w-6 shrink-0 items-center justify-center rounded-lg text-xs font-semibold",
				abcColors[abc],
			)}
		>
			{abc}
		</span>
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
			<Icon className="size-10 text-[#b5b5b5]" strokeWidth={1.5} />
			<p className="text-base font-semibold">{title}</p>
			{children && (
				<div className="max-w-sm text-muted-foreground">{children}</div>
			)}
		</div>
	);
}
