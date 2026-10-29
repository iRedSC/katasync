import {
	createFileRoute,
	Link,
	useNavigate,
	useRouter,
} from "@tanstack/react-router";
import { Plus, Search, Users } from "lucide-react";
import { useEffect, useState } from "react";
import { Page } from "#/components/page";
import {
	Board,
	nextInColumn,
	type Place,
	positionAt,
} from "#/components/repairs/board";
import { NewRepairDialog } from "#/components/repairs/new-repair-dialog";
import { ListSkeleton } from "#/components/skeleton";
import { Button } from "#/components/ui/button";
import { Tip } from "#/components/ui/tooltip";
import { useHotkeys } from "#/lib/hotkeys";
import { optimism, optimistic } from "#/lib/optimism";
import { matchText, textMatcher } from "#/lib/search-ranking";
import { offerUndo } from "#/lib/undo";
import { printPdf } from "#/printing/qz-client";
import { repairNumber } from "#/repairs/number";
import type { RepairCard } from "#/repairs/read";
import { statusNames } from "#/repairs/status";
import { listProductIndex } from "#/server/catalog";
import { getBoard, moveRepairTo } from "#/server/repairs";

export const Route = createFileRoute("/repairs/")({
	loader: async () => {
		const [board, index] = await Promise.all([getBoard(), listProductIndex()]);
		return { board, index };
	},
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
	const d = boardData.useData("all", loaded.board);
	const navigate = useNavigate();
	const [creating, setCreating] = useState(false);
	const [fresh, setFresh] = useState<number | null>(null);
	const [query, setQuery] = useState("");
	useHotkeys({ n: () => setCreating(true) });
	useRefresh();

	const q = query.trim();
	const typed = textMatcher(q);
	const cards = q
		? d.cards.filter((c) =>
				typed(
					matchText(
						[
							`r${c.id}`,
							c.customerName,
							c.returnOrderName,
							c.customerPhone,
							...c.tools.flatMap((t) => [t.tool, t.serial]),
							c.technician,
						].join(" "),
					),
				),
			)
		: d.cards;

	async function move(card: RepairCard, place: Place) {
		const from = card.status;
		// A listed bench job is done for good (the board refuses it).
		if (from === "refurbished") return;
		const back: Place = { to: from, before: nextInColumn(d.cards, card) };
		const set = ({ to, before }: Place) =>
			boardData.patch("all", (b) => ({
				...b,
				cards: b.cards.map((c) =>
					c.id === card.id
						? {
								...c,
								status: to,
								position: positionAt(b.cards, c, { to, before }),
								statusChangedAt:
									to === c.status ? c.statusChangedAt : new Date(),
							}
						: c,
				),
			}));
		const send =
			({ to, before }: Place) =>
			() =>
				moveRepairTo({ data: { id: card.id, to, before } });
		const r = await optimism.change({
			label: `Moving R${card.id}`,
			patch: set(place),
			send: send(place),
		});
		if (!r) return;
		// Moving within a column is undone by moving it back by hand.
		if (place.to === from) return;
		offerUndo(`R${card.id} to ${statusNames[place.to]}`, {
			undo: async () => {
				const done = await optimism.change({
					label: `Moving R${card.id} back`,
					patch: set(back),
					send: send(back),
				});
				return done && `R${card.id} back in ${statusNames[from]}`;
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
				products={loaded.index}
				onMade={(id) => {
					setFresh(id);
					setTimeout(() => setFresh((f) => (f === id ? null : f)), 4000);
					void printPdf(`/labels/repairs/${id}`, `R${id} ticket`);
				}}
			/>
		</Page>
	);
}
