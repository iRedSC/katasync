import type { LinkProps } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { Card, Page } from "#/components/page";
import { cn } from "#/lib/utils";

// Stand-ins shown the moment a page is opened, shaped like the page so it
// doesn't jump when the data lands. What's known without the data (the
// title, the way back, the card headings) is real; only the data is a bone.

// A gray block where text or a picture will be. A span, so it fits in titles.
export function Bone({ className }: { className?: string }) {
	return (
		<span
			aria-hidden
			className={cn(
				"block animate-pulse rounded-md bg-surface-strong",
				className,
			)}
		/>
	);
}

// Rows of a table or list, each a picture-sized bone and two lines of text.
function Rows({ rows, picture }: { rows: number; picture: boolean }) {
	return (
		<div>
			{Array.from({ length: rows }, (_, i) => (
				<div
					// biome-ignore lint/suspicious/noArrayIndexKey: placeholders have no identity
					key={i}
					className="flex items-center gap-3 border-t px-4 py-2.5 first:border-t-0"
				>
					{picture && <Bone className="size-9 shrink-0 rounded-lg" />}
					<div className="flex min-w-0 flex-1 flex-col gap-1.5">
						{/* Varied widths, so it reads as a list rather than stripes. */}
						<Bone className={cn("h-3.5", WIDTHS[i % WIDTHS.length])} />
						<Bone className="h-3 w-20" />
					</div>
					<Bone className="hidden h-3.5 w-16 md:block" />
					<Bone className="h-5 w-20" />
				</div>
			))}
		</div>
	);
}

const WIDTHS = ["w-2/5", "w-1/2", "w-1/3", "w-3/5", "w-2/5", "w-1/4"];

// A card of rows: Orders, Purchase orders, Inventory history.
export function ListCard({
	title,
	rows = 8,
	picture = false,
	tabs = false,
}: {
	title?: ReactNode;
	rows?: number;
	picture?: boolean;
	// The view switcher some lists have along the top.
	tabs?: boolean;
}) {
	return (
		<Card title={title} flush>
			{tabs && (
				<div className="flex gap-2 border-b p-2">
					<Bone className="h-7 w-20" />
					<Bone className="h-7 w-24" />
				</div>
			)}
			<div className="border-y bg-subtle px-4 py-2">
				<Bone className="h-3 w-24" />
			</div>
			<Rows rows={rows} picture={picture} />
		</Card>
	);
}

// A card of label and value lines: an address, a supplier, a summary.
export function FieldsCard({
	title,
	lines = 3,
}: {
	title?: ReactNode;
	lines?: number;
}) {
	return (
		<Card title={title}>
			<div className="flex flex-col gap-2">
				{Array.from({ length: lines }, (_, i) => (
					<Bone
						// biome-ignore lint/suspicious/noArrayIndexKey: placeholders have no identity
						key={i}
						className={cn(
							"h-3.5",
							i === 0 ? "w-3/4" : WIDTHS[i % WIDTHS.length],
						)}
					/>
				))}
			</div>
		</Card>
	);
}

// A list page: the real title over cards of rows.
export function ListSkeleton({
	title,
	back,
	width,
	children,
}: {
	title: ReactNode;
	back?: LinkProps;
	width?: "narrow" | "wide";
	// The cards, when the page isn't one plain list.
	children?: ReactNode;
}) {
	return (
		<Page title={title} back={back} width={width}>
			{children ?? <ListCard />}
		</Page>
	);
}

// One record: an order, a product, a PO. Its name isn't known until it
// loads, but the way back works at once.
export function DetailSkeleton({
	back,
	width = "narrow",
	main,
	side,
}: {
	back: LinkProps;
	width?: "narrow" | "wide";
	main: ReactNode;
	side: ReactNode;
}) {
	return (
		<Page
			back={back}
			width={width}
			title={<Bone className="h-6 w-56 max-w-full" />}
		>
			<div
				className={cn(
					"grid gap-4",
					width === "wide"
						? "xl:grid-cols-[minmax(0,1fr)_20rem]"
						: "lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]",
				)}
			>
				<div className="flex min-w-0 flex-col gap-4">{main}</div>
				<div className="flex min-w-0 flex-col gap-4">{side}</div>
			</div>
		</Page>
	);
}

// A PO, whether it already has a number or is being made from a supplier's
// suggestion.
export function PurchaseOrderSkeleton() {
	return (
		<DetailSkeleton
			back={{ to: "/purchasing" }}
			width="wide"
			main={<ListCard rows={8} picture />}
			side={
				<>
					<FieldsCard title="Supplier" lines={4} />
					<FieldsCard title="Delivery" />
				</>
			}
		/>
	);
}

// The receiving app's own frame: big type, cards on a phone.
export function ReceiveSkeleton({ title }: { title?: string }) {
	return (
		<main className="mx-auto min-h-svh max-w-xl bg-background px-4 pt-[max(1rem,env(safe-area-inset-top))] pb-[max(2rem,env(safe-area-inset-bottom))]">
			<header className="flex min-h-14 items-center py-2">
				{title ? (
					<h1 className="text-3xl font-bold">{title}</h1>
				) : (
					<div className="flex items-center gap-3">
						<Bone className="size-14 rounded-full" />
						<div className="flex flex-col gap-2">
							<Bone className="h-6 w-48" />
							<Bone className="h-4 w-20" />
						</div>
					</div>
				)}
			</header>
			<ul className="mt-2 flex flex-col gap-3">
				{Array.from({ length: 4 }, (_, i) => (
					<li
						// biome-ignore lint/suspicious/noArrayIndexKey: placeholders have no identity
						key={i}
						className="flex flex-col gap-2 rounded-2xl bg-card p-4 shadow-card"
					>
						<Bone className="h-7 w-3/5" />
						<Bone className="h-5 w-1/4" />
					</li>
				))}
			</ul>
		</main>
	);
}
