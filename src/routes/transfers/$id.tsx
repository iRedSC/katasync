import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { ArrowLeftRight } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { Badge, Card, Page } from "#/components/page";
import { DetailSkeleton, ListCard } from "#/components/skeleton";
import { AddProduct } from "#/components/transfers/add-product";
import { Arrivals } from "#/components/transfers/arrivals";
import { LineTable } from "#/components/transfers/line-table";
import { Suggestions } from "#/components/transfers/suggestions";
import { Button } from "#/components/ui/button";
import { formatCount, formatDateTime } from "#/lib/format";
import { optimism } from "#/lib/optimism";
import { offerUndo } from "#/lib/undo";
import { listProductIndex } from "#/server/catalog";
import {
	editTransfer,
	fillTransfer,
	getTransfer,
	receiveTransferNow,
	removeTransfer,
	sendTransferNow,
	setTransferLine,
	undoTransferArrival,
	undoTransferSend,
} from "#/server/transfers";

export const Route = createFileRoute("/transfers/$id")({
	loader: async ({ params }) => {
		const [detail, index] = await Promise.all([
			getTransfer({ data: { id: Number(params.id) } }),
			listProductIndex(),
		]);
		return { ...detail, index };
	},
	component: TransferPage,
	pendingComponent: () => (
		<DetailSkeleton
			back={{ to: "/transfers" }}
			width="narrow"
			main={<ListCard title="Moving" rows={3} picture />}
			side={null}
		/>
	),
});

function TransferPage() {
	const {
		transfer: t,
		lines,
		suggestions,
		index,
		delivery,
	} = Route.useLoaderData();
	const navigate = useNavigate();
	const draft = t.status === "draft";
	const name = `T${t.id}`;
	const units = lines.reduce((n, l) => n + l.quantity, 0);
	const [note, setNote] = useState(t.note ?? "");

	// Every change goes to the server, then the page reloads what it says.
	// The engine does that reload, so a change resolves once it's in.
	function change<T>(send: () => Promise<T>) {
		return optimism.change({ send });
	}

	async function send() {
		const r = await change(() => sendTransferNow({ data: { id: t.id } }));
		if (!r) return;
		offerUndo(`${name} sent: ${formatCount(units)} on the way to ${t.to}`, {
			tone: "success",
			undo: async () => {
				const undone = await change(() =>
					undoTransferSend({ data: { id: t.id } }),
				);
				return undone && `${name} is a draft again`;
			},
		});
	}

	async function receive(counts: { productId: number; quantity: number }[]) {
		const receiptKey = crypto.randomUUID();
		const r = await change(() =>
			receiveTransferNow({ data: { id: t.id, receiptKey, lines: counts } }),
		);
		if (!r) return r;
		const arrived = counts.reduce((n, c) => n + c.quantity, 0);
		offerUndo(`${formatCount(arrived)} arrived at ${t.to}`, {
			tone: "success",
			undo: async () => {
				const undone = await change(() =>
					undoTransferArrival({
						data: { id: t.id, receiptId: r.value.receiptId },
					}),
				);
				return undone && "Back in transit";
			},
		});
		return r;
	}

	const status =
		delivery.kind === "draft"
			? { tone: "info" as const, label: "Draft" }
			: delivery.kind === "in_transit"
				? { tone: "warning" as const, label: "In transit" }
				: { tone: "success" as const, label: "Arrived" };

	async function fill() {
		const r = await change(() => fillTransfer({ data: { id: t.id } }));
		if (r)
			toast.success(`Added ${formatCount(r.value.filled)} to top up ${t.to}`);
	}

	return (
		<Page
			width="narrow"
			back={{ to: "/transfers" }}
			title={
				<span className="flex items-center gap-2">
					{name}
					<Badge tone={status.tone}>{status.label}</Badge>
				</span>
			}
			actions={
				draft ? (
					<>
						<Button
							variant="outline"
							onClick={async () => {
								const r = await change(() =>
									removeTransfer({ data: { id: t.id } }),
								);
								if (r) {
									toast.success(`${name} deleted`);
									navigate({ to: "/transfers" });
								}
							}}
						>
							Delete
						</Button>
						<Button onClick={send} disabled={lines.length === 0}>
							Send {formatCount(units)} to {t.to}
						</Button>
					</>
				) : (
					<Button
						variant="outline"
						onClick={async () => {
							const r = await change(() =>
								undoTransferSend({ data: { id: t.id } }),
							);
							if (r) toast.success(`${name} moved back; it's a draft again`);
						}}
					>
						Undo send
					</Button>
				)
			}
		>
			<Card>
				<div className="flex flex-wrap items-center gap-3">
					<span className="font-semibold">{t.from}</span>
					{draft ? (
						<button
							type="button"
							aria-label="Swap direction"
							onClick={() =>
								change(() => editTransfer({ data: { id: t.id, swap: true } }))
							}
							className="rounded-lg p-1.5 hover:bg-surface-strong"
						>
							<ArrowLeftRight className="size-4" />
						</button>
					) : (
						<span>→</span>
					)}
					<span className="font-semibold">{t.to}</span>
					<span className="ml-auto text-muted-foreground">
						{t.sentAt
							? `Sent ${formatDateTime(t.sentAt)}`
							: `Started ${formatDateTime(t.createdAt)}`}
					</span>
				</div>
				<textarea
					value={note}
					disabled={!draft}
					onChange={(e) => setNote(e.target.value)}
					onBlur={() =>
						note !== (t.note ?? "") &&
						change(() => editTransfer({ data: { id: t.id, note } }))
					}
					placeholder={draft ? "Note (optional)" : ""}
					rows={note ? 2 : 1}
					className="mt-3 w-full resize-none rounded-lg bg-surface px-3 py-2 outline-none disabled:bg-transparent disabled:px-0"
				/>
			</Card>

			<Card
				title={`Moving ${formatCount(lines.length)} ${lines.length === 1 ? "product" : "products"}`}
				flush
			>
				{lines.length > 0 && (
					<LineTable
						lines={lines}
						from={t.from}
						to={t.to}
						editable={draft}
						onQuantity={(l, quantity) =>
							change(() =>
								setTransferLine({
									data: { id: t.id, productId: l.productId, quantity },
								}),
							)
						}
					/>
				)}
				{draft && (
					<div className={lines.length > 0 ? "border-t" : ""}>
						<AddProduct
							products={index}
							exclude={new Set(lines.map((l) => l.productId))}
							onAdd={(p) =>
								change(() =>
									setTransferLine({
										data: { id: t.id, productId: p.id, quantity: 1 },
									}),
								)
							}
						/>
					</div>
				)}
			</Card>

			{(delivery.kind === "in_transit" || delivery.kind === "received") && (
				<Arrivals
					delivery={delivery}
					lines={lines}
					to={t.to}
					onReceive={receive}
					onUndo={(receiptId) =>
						change(() => undoTransferArrival({ data: { id: t.id, receiptId } }))
					}
				/>
			)}

			{draft && suggestions.length > 0 && (
				<Suggestions
					rows={suggestions}
					to={t.to}
					onAddAll={fill}
					onAdd={(s) =>
						change(() =>
							setTransferLine({
								data: {
									id: t.id,
									productId: s.productId,
									quantity: s.suggested,
								},
							}),
						)
					}
				/>
			)}
		</Page>
	);
}
