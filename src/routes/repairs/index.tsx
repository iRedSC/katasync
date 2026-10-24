import {
	createFileRoute,
	Link,
	useNavigate,
	useRouter,
} from "@tanstack/react-router";
import { Plus, Search, Users } from "lucide-react";
import { useEffect, useState } from "react";
import { Page } from "#/components/page";
import { Board } from "#/components/repairs/board";
import { NewRepairDialog } from "#/components/repairs/new-repair-dialog";
import { ListSkeleton } from "#/components/skeleton";
import { Button } from "#/components/ui/button";
import { Tip } from "#/components/ui/tooltip";
import { useHotkeys } from "#/lib/hotkeys";
import { optimism, optimistic } from "#/lib/optimism";
import { offerUndo } from "#/lib/undo";
import { printPdf } from "#/printing/qz-client";
import { repairNumber } from "#/repairs/number";
import type { RepairCard } from "#/repairs/read";
import { type RepairStatus, statusNames } from "#/repairs/status";
import { getBoard, moveRepairTo } from "#/server/repairs";

export const Route = createFileRoute("/repairs/")({
	loader: () => getBoard(),
	component: Repairs,
	pendingComponent: () => <ListSkeleton title="Repairs" />,
});

type Loaded = Awaited<ReturnType<typeof getBoard>>;
const boardData = optimistic<Loaded>("repair-board");

// The board may hang on the shop wall, so it reloads itself every minute
// while it's showing, picking up payments and moves made elsewhere.
function useRefresh() {
	const router = useRouter();
	useEffect(() => {
		const timer = setInterval(() => {
			if (document.visibilityState === "visible" && !optimism.saving())
				void router.invalidate();
		}, 60_000);
		return () => clearInterval(timer);
	}, [router]);
}

function Repairs() {
	const loaded = Route.useLoaderData();
	const d = boardData.useData("all", loaded);
	const navigate = useNavigate();
	const [creating, setCreating] = useState(false);
	const [fresh, setFresh] = useState<number | null>(null);
	const [query, setQuery] = useState("");
	useHotkeys({ n: () => setCreating(true) });
	useRefresh();

	const q = query.trim().toLowerCase();
	const cards = q
		? d.cards.filter((c) =>
				[
					`r${c.id}`,
					c.customerName,
					c.customerPhone ?? "",
					c.tool,
					c.serial ?? "",
					c.technician ?? "",
				].some((s) => s.toLowerCase().includes(q)),
			)
		: d.cards;

	async function move(card: RepairCard, to: RepairStatus) {
		const from = card.status;
		const set = (status: RepairStatus) =>
			boardData.patch("all", (b) => ({
				...b,
				cards: b.cards.map((c) =>
					c.id === card.id ? { ...c, status, statusChangedAt: new Date() } : c,
				),
			}));
		const r = await optimism.change({
			label: `Moving R${card.id}`,
			patch: set(to),
			send: () => moveRepairTo({ data: { id: card.id, to } }),
		});
		if (!r) return;
		offerUndo(`R${card.id} to ${statusNames[to]}`, {
			undo: async () => {
				const back = await optimism.change({
					label: `Moving R${card.id} back`,
					patch: set(from),
					send: () => moveRepairTo({ data: { id: card.id, to: from } }),
				});
				return back && `R${card.id} back in ${statusNames[from]}`;
			},
		});
	}

	return (
		<Page
			title="Repairs"
			width="wide"
			actions={
				<>
					<Button variant="outline" asChild>
						<Link to="/repairs/customers">
							<Users />
							Customers
						</Link>
					</Button>
					<Tip content="N">
						<Button onClick={() => setCreating(true)}>
							<Plus />
							New repair
						</Button>
					</Tip>
				</>
			}
		>
			<div className="flex items-center gap-3">
				<label className="flex h-9 w-full max-w-sm items-center gap-2 rounded-lg bg-card px-3 shadow-card">
					<Search className="size-4 text-muted-foreground" />
					<input
						value={query}
						onChange={(e) => setQuery(e.target.value)}
						onKeyDown={(e) => {
							if (e.key !== "Enter") return;
							const n = repairNumber(query);
							if (n !== null) {
								setQuery("");
								navigate({ to: "/repairs/$id", params: { id: String(n) } });
							}
						}}
						placeholder="Find or scan a ticket"
						className="w-full bg-transparent outline-none"
					/>
				</label>
				{d.refreshError && (
					<Tip content={d.refreshError}>
						<span className="text-sm text-warning-text">
							Couldn't check Shopify for payments
						</span>
					</Tip>
				)}
			</div>
			<Board cards={cards} fresh={fresh} onMove={move} />
			<NewRepairDialog
				open={creating}
				onOpenChange={setCreating}
				people={d.people}
				onMade={(id) => {
					setFresh(id);
					setTimeout(() => setFresh((f) => (f === id ? null : f)), 4000);
					void printPdf(`/labels/repairs/${id}`, `R${id} ticket`);
				}}
			/>
		</Page>
	);
}
