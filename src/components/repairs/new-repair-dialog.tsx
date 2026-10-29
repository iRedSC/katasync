import { Plus, X } from "lucide-react";
import { type FormEvent, useState } from "react";
import type { IndexedProduct } from "#/components/transfers/add-product";
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
import { cn } from "#/lib/utils";
import type { Person } from "#/repairs/people";
import { startBenchJob } from "#/server/bench";
import { startRepair } from "#/server/repairs";
import {
	CustomerFields,
	CustomerPicker,
	type FoundCustomer,
	type NewCustomer,
} from "./customer-picker";
import { TechPicker } from "./tech-picker";
import { ToolInput } from "./tool-input";

// Taking tools in at the counter: whose they are, what each is and what's
// wrong with it, and who'll fix them. Saving prints a ticket for each to tie
// on it. Ours, to refurbish, is one tool.

type Who =
	| { kind: "found"; customer: FoundCustomer }
	| { kind: "new"; fields: NewCustomer };

type Row = {
	key: number;
	tool: string;
	picked: IndexedProduct | null;
	serial: string;
	problem: string;
};

let rows = 0;
const blank = (): Row => ({
	key: ++rows,
	tool: "",
	picked: null,
	serial: "",
	problem: "",
});

export function NewRepairDialog({
	open,
	onOpenChange,
	people,
	products,
	onMade,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	people: Person[];
	products: IndexedProduct[];
	onMade: (id: number) => void;
}) {
	const [who, setWho] = useState<Who | null>(null);
	// Ours, to refurbish: no customer, and a catalog product to make the
	// refurb from (src/repairs/bench.ts).
	const [bench, setBench] = useState(false);
	const [tools, setTools] = useState<Row[]>(() => [blank()]);
	const [technicianId, setTechnicianId] = useState<number | null>(null);
	const [busy, setBusy] = useState(false);

	const named =
		who?.kind === "found" ||
		(who?.kind === "new" &&
			(who.fields.firstName.trim() || who.fields.lastName.trim()));
	const [first] = tools;
	const ready =
		(bench
			? first.picked !== null
			: named && tools.every((t) => t.tool.trim() !== "")) && !busy;
	const change = (key: number, row: Partial<Row>) =>
		setTools((ts) => ts.map((t) => (t.key === key ? { ...t, ...row } : t)));

	function reset() {
		setWho(null);
		setTools([blank()]);
		setTechnicianId(null);
	}

	async function submit(e: FormEvent) {
		e.preventDefault();
		if (!ready) return;
		if (bench) {
			const { picked } = first;
			if (!picked) return;
			setBusy(true);
			const made = await optimism.change({
				send: () =>
					startBenchJob({
						data: {
							productId: picked.id,
							tool: first.tool,
							serial: first.serial.trim() || null,
							problem: first.problem,
							technicianId,
						},
					}),
			});
			setBusy(false);
			if (!made) return;
			reset();
			onOpenChange(false);
			onMade(made.value.ids[0]);
			return;
		}
		if (!who) return;
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
						tools: tools.map((t) => ({
							tool: t.tool,
							productId: t.picked?.id ?? null,
							serial: t.serial.trim() || null,
							problem: t.problem,
						})),
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
				<form onSubmit={submit} className="flex min-w-0 flex-col gap-5">
					<DialogHeader>
						<DialogTitle>New repair</DialogTitle>
						<DialogDescription className="sr-only">
							Whose tool it is, what it is, and what is wrong with it
						</DialogDescription>
					</DialogHeader>

					<div className="flex rounded-lg bg-surface p-0.5 text-sm font-medium">
						{[
							{ label: "Customer's", value: false },
							{ label: "Ours, to refurbish", value: true },
						].map((o) => (
							<button
								key={o.label}
								type="button"
								onClick={() => {
									setBench(o.value);
									// Ours is one tool.
									if (o.value) setTools((ts) => ts.slice(0, 1));
								}}
								className={cn(
									"flex-1 rounded-md py-1.5 text-muted-foreground",
									bench === o.value && "bg-card text-foreground shadow-card",
								)}
							>
								{o.label}
							</button>
						))}
					</div>

					{bench ? null : who === null ? (
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

					{tools.map((t, i) => (
						<div
							key={t.key}
							className={cn(
								"flex flex-col gap-2",
								tools.length > 1 &&
									"rounded-lg border border-border p-2 animate-in fade-in slide-in-from-top-1",
							)}
						>
							<div className="flex items-center gap-2">
								<div className="grid flex-1 grid-cols-[2fr_1fr] gap-2">
									<ToolInput
										value={t.tool}
										productId={t.picked?.id ?? null}
										products={products}
										onChange={(text, id) =>
											change(t.key, {
												tool: text,
												picked:
													id === null
														? null
														: (products.find((p) => p.id === id) ?? null),
											})
										}
										placeholder={
											bench
												? "Pick the tool from the catalog"
												: i === 0
													? "Tool, e.g. TapeTech 88TTE taper"
													: "Another tool"
										}
										className={cn(
											"h-9 rounded-lg border border-input bg-white px-3 focus-within:border-ring",
											// Ours needs a catalog product to make its refurb from.
											bench &&
												t.tool.trim() !== "" &&
												!t.picked &&
												"border-warning-border focus-within:border-warning-border",
										)}
									/>
									<input
										value={t.serial}
										onChange={(e) => change(t.key, { serial: e.target.value })}
										placeholder="Serial"
										className="h-9 rounded-lg border border-input bg-white px-3 outline-none focus:border-ring"
									/>
								</div>
								{tools.length > 1 && (
									<button
										type="button"
										aria-label="Not this tool"
										onClick={() =>
											setTools((ts) => ts.filter((x) => x.key !== t.key))
										}
										className="rounded-md p-1 hover:bg-surface-strong"
									>
										<X className="size-4" />
									</button>
								)}
							</div>
							<textarea
								value={t.problem}
								onChange={(e) => change(t.key, { problem: e.target.value })}
								placeholder="What's wrong with it"
								rows={tools.length > 1 ? 2 : 3}
								className="resize-none rounded-lg border border-input bg-white px-3 py-2 outline-none focus:border-ring"
							/>
						</div>
					))}
					{!bench && (
						<button
							type="button"
							onClick={() => setTools((ts) => [...ts, blank()])}
							className="-mt-2 flex items-center gap-1.5 self-start rounded-md px-1 text-sm font-medium text-link"
						>
							<Plus className="size-4" />
							Another tool
						</button>
					)}
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
							{busy
								? "Saving…"
								: tools.length > 1
									? `Take in and print ${tools.length} tickets`
									: "Take in and print ticket"}
						</Button>
					</DialogFooter>
				</form>
			</DialogContent>
		</Dialog>
	);
}
