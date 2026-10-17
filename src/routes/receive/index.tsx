import { createFileRoute, Link, useRouter } from "@tanstack/react-router";
import { Check, ChevronRight, RefreshCw } from "lucide-react";
import { receiveHead } from "#/components/receive/pwa";
import { Saving } from "#/components/saving";
import { ReceiveSkeleton } from "#/components/skeleton";
import { cn } from "#/lib/utils";
import { listReceivable } from "#/server/purchasing";

export const Route = createFileRoute("/receive/")({
	head: receiveHead,
	loader: () => listReceivable(),
	component: Receive,
	pendingComponent: () => <ReceiveSkeleton title="Receiving" />,
});

const day = new Intl.DateTimeFormat("en-US", {
	month: "short",
	day: "numeric",
});

function Receive() {
	const orders = Route.useLoaderData();
	const router = useRouter();

	return (
		<main className="mx-auto min-h-svh max-w-xl bg-background px-4 pt-[max(1rem,env(safe-area-inset-top))] pb-[max(2rem,env(safe-area-inset-bottom))]">
			<header className="flex items-center justify-between py-2">
				<h1 className="text-3xl font-bold">Receiving</h1>
				<div className="flex items-center gap-3">
					<Saving className="text-base text-muted-foreground" />
					{/* The installed app has no browser reload button. */}
					<button
						type="button"
						aria-label="Refresh"
						onClick={() => router.invalidate()}
						className="flex size-14 items-center justify-center rounded-full bg-card shadow-card active:bg-surface-strong"
					>
						<RefreshCw className="size-6" />
					</button>
				</div>
			</header>

			{orders.length === 0 ? (
				<div className="flex flex-col items-center gap-5 py-24 text-center">
					<div className="flex size-28 items-center justify-center rounded-full bg-success-fill text-success-icon">
						<Check className="size-16" strokeWidth={3} />
					</div>
					<p className="text-3xl font-bold">Nothing to receive</p>
				</div>
			) : (
				<ul className="mt-2 flex flex-col gap-3">
					{orders.map((po) => {
						const percent =
							po.ordered > 0 ? (po.received / po.ordered) * 100 : 0;
						const expected = po.expectedAt ? new Date(po.expectedAt) : null;
						const startOfToday = new Date().setHours(0, 0, 0, 0);
						const late = expected !== null && expected.getTime() < startOfToday;
						return (
							<li key={po.id}>
								<Link
									to="/receive/$id"
									params={{ id: String(po.id) }}
									// A phone has no hover to load ahead on, and the list is short.
									preload="viewport"
									className="block rounded-2xl bg-card p-4 shadow-card active:bg-subtle"
								>
									<div className="flex items-center gap-3">
										<div className="min-w-0 flex-1">
											<p className="truncate text-2xl font-bold">
												{po.supplierName}
											</p>
											<p className="text-lg text-muted-foreground">
												PO {po.id}
											</p>
										</div>
										<ChevronRight className="size-8 shrink-0 text-muted-foreground" />
									</div>
									<div className="mt-4 h-3 overflow-hidden rounded-full bg-surface-strong">
										<div
											className="h-full rounded-full bg-primary"
											style={{ width: `${percent}%` }}
										/>
									</div>
									<div className="mt-2 flex items-baseline justify-between gap-3">
										<p className="text-lg font-semibold tabular-nums">
											{po.received} of {po.ordered}{" "}
											{po.ordered === 1 ? "item" : "items"}
										</p>
										{expected && (
											<p
												className={cn(
													"shrink-0 text-base",
													late
														? "font-semibold text-critical-text"
														: "text-muted-foreground",
												)}
											>
												{late ? "Late, " : ""}
												{late ? "expected" : "Expected"} {day.format(expected)}
											</p>
										)}
									</div>
								</Link>
							</li>
						);
					})}
				</ul>
			)}
		</main>
	);
}
