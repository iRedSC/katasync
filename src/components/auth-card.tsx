import type { ReactNode } from "react";

// The one card on the sign-in and setup pages, centered on the app's gray.
export function AuthCard({
	title,
	children,
}: {
	title: string;
	children: ReactNode;
}) {
	return (
		<main className="flex min-h-svh items-center justify-center bg-background px-4">
			<div className="flex w-full max-w-sm flex-col gap-4 rounded-xl bg-card p-6 shadow-card">
				<div className="flex items-center gap-2">
					<img src="/favicon.svg" alt="" className="size-8" />
					<span className="text-base font-semibold">katasync</span>
				</div>
				<h1 className="text-xl font-bold">{title}</h1>
				{children}
			</div>
		</main>
	);
}
