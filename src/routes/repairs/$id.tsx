import { createFileRoute } from "@tanstack/react-router";
import { FileText, Printer } from "lucide-react";
import { toast } from "sonner";
import { Page } from "#/components/page";
import { ListBenchCard, SourceCard } from "#/components/repairs/bench-side";
import { repairActions, repairData } from "#/components/repairs/repair-data";
import {
	BillCard,
	CustomerCard,
	PeopleCard,
} from "#/components/repairs/repair-side";
import { StatusBar } from "#/components/repairs/status-bar";
import { AddTool, OtherCard, ToolCard } from "#/components/repairs/tool-card";
import { DetailSkeleton, ListCard } from "#/components/skeleton";
import { Button } from "#/components/ui/button";
import { ids, optimism } from "#/lib/optimism";
import { offerUndo } from "#/lib/undo";
import { printPdf } from "#/printing/qz-client";
import { isOnBoard, type MoveTarget, statusNames } from "#/repairs/status";
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
			main={<ListCard title="Tool" rows={3} />}
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

	async function move(to: MoveTarget) {
		const from = r.status;
		if (from === "refurbished") return;
		const go = (status: MoveTarget) =>
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
						{r.kind === "bench"
							? d.tools[0]?.tool
							: [r.customerName, toolSummary(d.tools)].join(", ")}
					</span>
				</span>
			}
			actions={
				<>
					{r.kind === "customer" && (
						<Button variant="outline" asChild>
							<a
								href={`/print/repairs/${r.id}`}
								target="_blank"
								rel="noreferrer"
							>
								<FileText />
								Invoice
							</a>
						</Button>
					)}
					<Button
						variant="outline"
						onClick={() =>
							printPdf(`/labels/repairs/${r.id}`, `R${r.id} tickets`)
						}
					>
						<Printer />
						{d.tools.length > 1 ? `${d.tools.length} tickets` : "Ticket"}
					</Button>
				</>
			}
		>
			<StatusBar d={d} onMove={move} />
			<div className="grid items-start gap-4 lg:grid-cols-[2fr_1fr]">
				<div className="flex flex-col gap-4">
					{d.tools.map((t, i) => (
						<ToolCard
							key={ids.key(t.id)}
							d={d}
							act={act}
							tool={t}
							place={i + 1}
							index={index}
							editable={editable}
						/>
					))}
					{r.kind === "customer" && (
						<>
							<OtherCard d={d} act={act} index={index} editable={editable} />
							{editable && <AddTool act={act} index={index} />}
						</>
					)}
				</div>
				<div className="flex flex-col gap-4">
					{r.kind === "bench" ? (
						<SourceCard d={d} />
					) : (
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
					)}
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
					{r.kind === "bench" ? (
						<ListBenchCard d={d} editable={editable} />
					) : (
						<BillCard
							d={d}
							onEmail={async () => {
								const sent = await optimism.change({
									send: () => emailRepairInvoice({ data: { id: r.id } }),
								});
								if (sent) toast.success(`Invoice sent to ${sent.value.sentTo}`);
							}}
						/>
					)}
				</div>
			</div>
		</Page>
	);
}

// The tools, for the title: the first, and how many more.
function toolSummary(tools: { tool: string }[]) {
	const [first, ...rest] = tools;
	if (!first) return "";
	return rest.length > 0 ? `${first.tool} +${rest.length}` : first.tool;
}
