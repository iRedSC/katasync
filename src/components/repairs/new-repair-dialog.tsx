import { X } from "lucide-react";
import { type FormEvent, useState } from "react";
import { Button } from "#/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "#/components/ui/dialog";
import { formatPhone } from "#/lib/format";
import { optimism } from "#/lib/optimism";
import type { Person } from "#/repairs/people";
import { startRepair } from "#/server/repairs";
import {
	CustomerFields,
	CustomerPicker,
	type FoundCustomer,
	type NewCustomer,
} from "./customer-picker";
import { TechPicker } from "./tech-picker";

// Taking a tool in at the counter: whose it is, what it is, what's wrong,
// and who'll fix it. Saving prints the ticket to tie on it.

type Who =
	| { kind: "found"; customer: FoundCustomer }
	| { kind: "new"; fields: NewCustomer };

export function NewRepairDialog({
	open,
	onOpenChange,
	people,
	onMade,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	people: Person[];
	onMade: (id: number) => void;
}) {
	const [who, setWho] = useState<Who | null>(null);
	const [tool, setTool] = useState("");
	const [serial, setSerial] = useState("");
	const [problem, setProblem] = useState("");
	const [technicianId, setTechnicianId] = useState<number | null>(null);
	const [busy, setBusy] = useState(false);

	const named =
		who?.kind === "found" ||
		(who?.kind === "new" &&
			(who.fields.firstName.trim() || who.fields.lastName.trim()));
	const ready = named && tool.trim() !== "" && !busy;

	function reset() {
		setWho(null);
		setTool("");
		setSerial("");
		setProblem("");
		setTechnicianId(null);
	}

	async function submit(e: FormEvent) {
		e.preventDefault();
		if (!ready || !who) return;
		setBusy(true);
		const customer =
			who.kind === "found"
				? {
						id: who.customer.id,
						name: who.customer.name,
						phone: who.customer.phone,
						email: who.customer.email,
					}
				: {
						new: {
							...who.fields,
							phone: who.fields.phone?.trim() || null,
							email: who.fields.email?.trim() || null,
						},
					};
		const r = await optimism.change({
			send: () =>
				startRepair({
					data: {
						customer,
						tool,
						serial: serial.trim() || null,
						problem,
						technicianId,
					},
				}),
		});
		setBusy(false);
		if (!r) return;
		reset();
		onOpenChange(false);
		onMade(r.value.id);
	}

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="sm:max-w-lg">
				<form onSubmit={submit} className="flex flex-col gap-5">
					<DialogHeader>
						<DialogTitle>New repair</DialogTitle>
						<DialogDescription className="sr-only">
							Whose tool it is, what it is, and what is wrong with it
						</DialogDescription>
					</DialogHeader>

					{who === null ? (
						<CustomerPicker
							onPick={(customer) => setWho({ kind: "found", customer })}
							onNew={(fields) => setWho({ kind: "new", fields })}
						/>
					) : who.kind === "found" ? (
						<div className="flex items-center gap-3 rounded-lg bg-surface px-3 py-2">
							<span className="flex-1 font-semibold">{who.customer.name}</span>
							<span className="text-muted-foreground">
								{who.customer.phone
									? formatPhone(who.customer.phone)
									: who.customer.email}
							</span>
							<button
								type="button"
								aria-label="Pick someone else"
								onClick={() => setWho(null)}
								className="rounded-md p-1 hover:bg-surface-strong"
							>
								<X className="size-4" />
							</button>
						</div>
					) : (
						<div className="flex flex-col gap-2">
							<div className="flex items-center justify-between text-sm">
								<span className="font-medium">
									New customer, added to Shopify
								</span>
								<button
									type="button"
									className="text-link"
									onClick={() => setWho(null)}
								>
									Search instead
								</button>
							</div>
							<CustomerFields
								value={who.fields}
								onChange={(fields) => setWho({ kind: "new", fields })}
							/>
						</div>
					)}

					<div className="grid grid-cols-[2fr_1fr] gap-2">
						<input
							value={tool}
							onChange={(e) => setTool(e.target.value)}
							placeholder="Tool, e.g. TapeTech 88TTE taper"
							className="h-9 rounded-lg border border-input bg-white px-3 outline-none focus:border-ring"
						/>
						<input
							value={serial}
							onChange={(e) => setSerial(e.target.value)}
							placeholder="Serial"
							className="h-9 rounded-lg border border-input bg-white px-3 outline-none focus:border-ring"
						/>
					</div>
					<textarea
						value={problem}
						onChange={(e) => setProblem(e.target.value)}
						placeholder="What's wrong with it"
						rows={3}
						className="resize-none rounded-lg border border-input bg-white px-3 py-2 outline-none focus:border-ring"
					/>
					<TechPicker
						people={people}
						value={technicianId}
						onChange={setTechnicianId}
					/>

					<DialogFooter>
						<Button
							type="submit"
							size="lg"
							className="w-full"
							disabled={!ready}
						>
							{busy ? "Saving…" : "Take in and print ticket"}
						</Button>
					</DialogFooter>
				</form>
			</DialogContent>
		</Dialog>
	);
}
