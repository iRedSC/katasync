import { createFileRoute, Link, useRouter } from "@tanstack/react-router";
import { Search, UserPlus } from "lucide-react";
import { type FormEvent, useEffect, useState } from "react";
import { toast } from "sonner";
import { Card, Page } from "#/components/page";
import {
	CustomerFields,
	type FoundCustomer,
	type NewCustomer,
	useCustomerSearch,
} from "#/components/repairs/customer-picker";
import { Button } from "#/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "#/components/ui/dialog";
import { formatCount, formatPhone } from "#/lib/format";
import { statusNames } from "#/repairs/status";
import { getCustomer, saveCustomer } from "#/server/repairs";

// Shopify's customers, found and edited from here; katasync keeps none of
// its own. Each shows the repairs they've brought in.
export const Route = createFileRoute("/repairs/customers")({
	component: Customers,
});

type Editing = { kind: "new" } | { kind: "edit"; customer: FoundCustomer };

function Customers() {
	const [query, setQuery] = useState("");
	const [saved, setSaved] = useState(0);
	// Searched again after each save, so an edit shows in the list.
	const { found, error } = useCustomerSearch(query, saved);
	const [editing, setEditing] = useState<Editing | null>(null);
	return (
		<Page
			title="Customers"
			back={{ to: "/repairs" }}
			width="narrow"
			actions={
				<Button onClick={() => setEditing({ kind: "new" })}>
					<UserPlus />
					New customer
				</Button>
			}
		>
			<Card flush>
				<label className="flex items-center gap-2 px-4 py-3">
					<Search className="size-4 text-muted-foreground" />
					<input
						// biome-ignore lint/a11y/noAutofocus: the page is for finding someone
						autoFocus
						value={query}
						onChange={(e) => setQuery(e.target.value)}
						placeholder="Phone number, name, or email"
						className="w-full bg-transparent outline-none"
					/>
				</label>
				<ul>
					{error && (
						<li className="border-t px-4 py-3 text-critical-text">{error}</li>
					)}
					{found === null && (
						<li className="border-t px-4 py-3 text-muted-foreground">
							Looking…
						</li>
					)}
					{found?.length === 0 && (
						<li className="border-t px-4 py-3 text-muted-foreground">
							Nobody matches
						</li>
					)}
					{found?.map((c) => (
						<li key={c.id}>
							<button
								type="button"
								onClick={() => setEditing({ kind: "edit", customer: c })}
								className="flex min-h-12 w-full items-center gap-3 border-t px-4 py-2 text-left hover:bg-subtle"
							>
								<span className="min-w-0 flex-1 truncate font-medium">
									{c.name}
								</span>
								<span className="w-36 tabular-nums text-muted-foreground">
									{c.phone && formatPhone(c.phone)}
								</span>
								<span className="hidden w-56 truncate text-muted-foreground sm:block">
									{c.email}
								</span>
								<span className="w-24 text-right text-muted-foreground tabular-nums">
									{c.openRepairs > 0 ? (
										<span className="text-info-text">
											{c.openRepairs} in shop
										</span>
									) : (
										`${formatCount(c.orders)} ${c.orders === 1 ? "order" : "orders"}`
									)}
								</span>
							</button>
						</li>
					))}
				</ul>
			</Card>
			<CustomerDialog
				editing={editing}
				onClose={() => setEditing(null)}
				onSaved={() => setSaved((n) => n + 1)}
			/>
		</Page>
	);
}

function CustomerDialog({
	editing,
	onClose,
	onSaved,
}: {
	editing: Editing | null;
	onClose: () => void;
	onSaved: () => void;
}) {
	const router = useRouter();
	const existing = editing?.kind === "edit" ? editing.customer : null;
	const [fields, setFields] = useState<NewCustomer>({
		firstName: "",
		lastName: "",
		phone: null,
		email: null,
	});
	const [busy, setBusy] = useState(false);
	const [history, setHistory] = useState<
		Awaited<ReturnType<typeof getCustomer>>["repairs"] | null
	>(null);
	useEffect(() => {
		setFields(
			existing
				? {
						firstName: existing.firstName,
						lastName: existing.lastName,
						phone: existing.phone,
						email: existing.email,
					}
				: { firstName: "", lastName: "", phone: null, email: null },
		);
		setHistory(null);
		if (existing)
			getCustomer({ data: { id: existing.id } }).then(
				(c) => setHistory(c.repairs),
				() => setHistory([]),
			);
	}, [existing]);

	async function submit(e: FormEvent) {
		e.preventDefault();
		if (busy) return;
		setBusy(true);
		try {
			const c = await saveCustomer({
				data: {
					...(existing && { id: existing.id }),
					fields: {
						...fields,
						phone: fields.phone?.trim() || null,
						email: fields.email?.trim() || null,
					},
				},
			});
			toast.success(
				existing ? `Saved ${c.name}` : `Added ${c.name} to Shopify`,
			);
			onSaved();
			onClose();
			await router.invalidate();
		} catch (err) {
			toast.error(err instanceof Error ? err.message : String(err));
		} finally {
			setBusy(false);
		}
	}

	return (
		<Dialog open={editing !== null} onOpenChange={(o) => !o && onClose()}>
			<DialogContent className="sm:max-w-lg">
				<form onSubmit={submit} className="flex flex-col gap-5">
					<DialogHeader>
						<DialogTitle>
							{existing ? existing.name : "New customer"}
						</DialogTitle>
						<DialogDescription className="sr-only">
							Their name, phone, and email in Shopify
						</DialogDescription>
					</DialogHeader>
					<CustomerFields value={fields} onChange={setFields} />
					{existing && history && history.length > 0 && (
						<ul className="flex flex-col">
							{history.map((r) => (
								<li key={r.id}>
									<Link
										to="/repairs/$id"
										params={{ id: String(r.id) }}
										className="flex items-center gap-3 rounded-lg px-2 py-1.5 hover:bg-subtle"
									>
										<span className="font-mono font-semibold">R{r.id}</span>
										<span className="min-w-0 flex-1 truncate">{r.tool}</span>
										<span className="text-muted-foreground">
											{statusNames[r.status]}
										</span>
									</Link>
								</li>
							))}
						</ul>
					)}
					<DialogFooter>
						<Button
							type="submit"
							className="w-full"
							size="lg"
							disabled={
								busy || (!fields.firstName.trim() && !fields.lastName.trim())
							}
						>
							{busy ? "Saving…" : existing ? "Save" : "Add to Shopify"}
						</Button>
					</DialogFooter>
				</form>
			</DialogContent>
		</Dialog>
	);
}
