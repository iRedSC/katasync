import { createFileRoute } from "@tanstack/react-router";
import { Printer } from "lucide-react";
import { toast } from "sonner";
import { Page } from "#/components/page";
import { LaborCard } from "#/components/repairs/labor-card";
import { PartsCard } from "#/components/repairs/parts-card";
import { repairActions, repairData } from "#/components/repairs/repair-data";
import {
	BillCard,
	CustomerCard,
	PeopleCard,
	ToolCard,
} from "#/components/repairs/repair-side";
import { StatusBar } from "#/components/repairs/status-bar";
import { DetailSkeleton, ListCard } from "#/components/skeleton";
import { Button } from "#/components/ui/button";
import { optimism } from "#/lib/optimism";
import { offerUndo } from "#/lib/undo";
import { printPdf } from "#/printing/qz-client";
import { isOnBoard, type RepairStatus, statusNames } from "#/repairs/status";
import { listProductIndex } from "#/server/catalog";
import {
	emailRepairInvoice,
	getRepairDetail,
	moveRepairTo,
} from "#/server/repairs";

export const Route = createFileRoute("/repairs/$id")({
	loader: async ({ params }) => {
		const [detail, index] = await Promise.all([
			getRepairDetail({ data: { id: Number(params.id) } }),
			listProductIndex(),
		]);
		return { detail, index };
	},
	component: RepairPage,
	pendingComponent: () => (
		<DetailSkeleton
			back={{ to: "/repairs" }}
			main={<ListCard title="Labor" rows={2} />}
			side={null}
		/>
	),
});

function RepairPage() {
	const { detail, index } = Route.useLoaderData();
	const d = repairData.useData(detail.repair.id, detail);
	const r = d.repair;
	const act = repairActions(d);
	const editable = isOnBoard(r.status);

	async function move(to: RepairStatus) {
		const from = r.status;
		const go = (status: RepairStatus) =>
			optimism.change({
				label: `Moving R${r.id}`,
				patch: repairData.patch(r.id, (x) => ({
					...x,
					repair: { ...x.repair, status },
				})),
				send: () => moveRepairTo({ data: { id: r.id, to: status } }),
			});
		if (!(await go(to))) return;
		offerUndo(`R${r.id} to ${statusNames[to]}`, {
			undo: async () =>
				(await go(from)) ? `R${r.id} back in ${statusNames[from]}` : null,
		});
	}

	return (
		<Page
			back={{ to: "/repairs" }}
			title={
				<span className="flex items-baseline gap-3">
					R{r.id}
					<span className="truncate text-base font-medium text-muted-foreground">
						{r.customerName}, {r.tool}
					</span>
				</span>
			}
			actions={
				<Button
					variant="outline"
					onClick={() => printPdf(`/labels/repairs/${r.id}`, `R${r.id} ticket`)}
				>
					<Printer />
					Ticket
				</Button>
			}
		>
			<StatusBar d={d} onMove={move} />
			<div className="grid items-start gap-4 lg:grid-cols-[2fr_1fr]">
				<div className="flex flex-col gap-4">
					<LaborCard
						d={d}
						editable={editable}
						onAdd={(minutes, note) => act.addLabor(minutes, note)}
						onEdit={(laborId, edit) => act.editLabor(laborId, edit)}
						onRemove={(laborId) => {
							const gone = d.labor.find((l) => l.id === laborId);
							void act.removeLabor(laborId).then(
								(done) =>
									done &&
									gone &&
									offerUndo("Time taken off", {
										undo: async () =>
											(await act.addLabor(gone.minutes, gone.note))
												? "Time put back"
												: null,
									}),
							);
						}}
					/>
					<PartsCard
						d={d}
						index={index}
						editable={editable}
						onSet={(part, quantity) => act.setPart(part, quantity)}
					/>
				</div>
				<div className="flex flex-col gap-4">
					<CustomerCard
						d={d}
						editable={editable}
						onChange={(c) =>
							act.edit(
								"The customer",
								{
									customer: {
										id: c.id,
										name: c.name,
										phone: c.phone,
										email: c.email,
									},
								},
								{
									customerId: c.id,
									customerName: c.name,
									customerPhone: c.phone,
									customerEmail: c.email,
								},
							)
						}
					/>
					<ToolCard
						d={d}
						products={index}
						editable={editable}
						onSave={(edit) => act.edit("The tool", edit, edit)}
					/>
					<PeopleCard
						d={d}
						onTechnician={(technicianId) =>
							act.edit(
								"Who has it",
								{ technicianId },
								{
									technicianId,
									technician:
										d.people.find((p) => p.id === technicianId)?.name ?? null,
								},
							)
						}
						onNotes={(notes) => act.edit("The notes", { notes }, { notes })}
					/>
					<BillCard
						d={d}
						onEmail={async () => {
							const sent = await optimism.change({
								send: () => emailRepairInvoice({ data: { id: r.id } }),
							});
							if (sent) toast.success(`Invoice sent to ${sent.value.sentTo}`);
						}}
					/>
				</div>
			</div>
		</Page>
	);
}
