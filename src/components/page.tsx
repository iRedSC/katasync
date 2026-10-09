import NumberFlow from "@number-flow/react";
import { Link, type LinkProps } from "@tanstack/react-router";
import {
	AlertTriangle,
	CheckCircle2,
	type LucideIcon,
	OctagonAlert,
} from "lucide-react";
import type { ReactNode } from "react";
import { SidebarTrigger } from "#/components/ui/sidebar";
import { cn } from "#/lib/utils";

export function PageHeader({
	title,
	actions,
}: {
	title: string;
	actions?: ReactNode;
}) {
	return (
		<header className="sticky top-0 z-10 bg-background/90 backdrop-blur">
			<div className="mx-auto flex h-16 w-full max-w-6xl items-center gap-3 px-4 md:px-8">
				<SidebarTrigger className="-ml-1 text-muted-foreground md:hidden" />
				<h1 className="min-w-0 flex-1 truncate text-xl font-semibold">
					{title}
				</h1>
				{actions && <div className="flex items-center gap-2">{actions}</div>}
			</div>
		</header>
	);
}

export function PageBody({
	children,
	className,
}: {
	children: ReactNode;
	className?: string;
}) {
	return (
		<div
			className={cn(
				"mx-auto flex w-full max-w-6xl flex-col gap-10 px-4 pt-4 pb-16 md:px-8",
				className,
			)}
		>
			{children}
		</div>
	);
}

export function Section({
	title,
	aside,
	children,
}: {
	title: string;
	aside?: ReactNode;
	children: ReactNode;
}) {
	return (
		<section className="flex flex-col gap-3">
			<div className="flex items-baseline justify-between gap-4">
				<h2 className="text-sm font-medium text-muted-foreground">{title}</h2>
				{aside && <div className="text-sm text-muted-foreground">{aside}</div>}
			</div>
			{children}
		</section>
	);
}

export type Tone = "good" | "warn" | "bad";

const tones: Record<
	Tone,
	{ icon: LucideIcon; label: string; text: string; wash: string; bar: string }
> = {
	bad: {
		icon: OctagonAlert,
		label: "Needs you",
		text: "text-bad",
		wash: "bg-bad/8",
		bar: "bg-bad",
	},
	warn: {
		icon: AlertTriangle,
		label: "Heads up",
		text: "text-warn",
		wash: "bg-warn/12",
		bar: "bg-warn",
	},
	good: {
		icon: CheckCircle2,
		label: "All good",
		text: "text-good",
		wash: "bg-good/8",
		bar: "bg-good",
	},
};

// A big number with a plain-words label, colored by what it means. The icon and
// the word say the same thing as the color, so color is never the only signal.
export function StatusTile({
	tone,
	value,
	label,
	hint,
	link,
}: {
	tone: Tone;
	value: number;
	label: string;
	hint?: string;
	link?: LinkProps;
}) {
	const t = tones[tone];
	const body = (
		<div
			className={cn(
				"relative flex h-full flex-col gap-2 overflow-hidden rounded-xl p-6 pl-7 transition-colors",
				t.wash,
				link && "hover:brightness-[0.98]",
			)}
		>
			<span className={cn("absolute inset-y-0 left-0 w-1.5", t.bar)} />
			<div className="flex items-center gap-1.5 text-sm font-medium">
				<t.icon className={cn("size-4", t.text)} />
				{t.label}
			</div>
			<div className="text-5xl font-semibold tracking-tight tabular-nums">
				<NumberFlow value={value} />
			</div>
			<div className="text-base font-medium">{label}</div>
			{hint && <div className="text-sm text-muted-foreground">{hint}</div>}
		</div>
	);
	return link ? (
		<Link {...link} className="block">
			{body}
		</Link>
	) : (
		body
	);
}

// A quiet dot + word, for status inside rows.
export function StatusDot({
	tone,
	children,
}: {
	tone: Tone;
	children: ReactNode;
}) {
	return (
		<span className="inline-flex items-center gap-1.5 text-sm">
			<span className={cn("size-2 rounded-full", tones[tone].bar)} />
			{children}
		</span>
	);
}

// For features whose backend isn't built yet. One calm line, not a card.
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
		<div className="flex flex-col items-center justify-center gap-3 py-24 text-center">
			<Icon className="size-8 text-muted-foreground/50" />
			<p className="text-lg font-medium">{title}</p>
			{children && (
				<div className="max-w-sm text-sm text-muted-foreground">{children}</div>
			)}
		</div>
	);
}
