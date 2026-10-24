import { Link, useNavigate } from "@tanstack/react-router";
import { Loader2, Plus } from "lucide-react";
import { type FormEvent, useEffect, useRef, useState } from "react";
import { shake } from "#/components/shake";
import { Button } from "#/components/ui/button";
import { optimism } from "#/lib/optimism";
import { cn } from "#/lib/utils";
import { newBankAccount } from "#/server/banking";
import type { Overview } from "./states";

const box =
	"h-8 rounded-lg border border-input bg-white px-2 outline-none transition-colors focus:border-ring aria-invalid:border-critical-text";

export function AccountBar({
	accounts,
	current,
}: Pick<Overview, "accounts"> & { current: number | null }) {
	const [adding, setAdding] = useState(accounts.length === 0);
	return (
		<div className="flex flex-wrap items-center gap-2">
			{accounts.map((a) => (
				<Link
					key={a.id}
					to="/reconciliation"
					search={{ account: a.id }}
					className={cn(
						"flex h-8 items-center gap-1.5 rounded-lg px-3 hover:bg-surface-strong",
						a.id === current && "bg-card font-medium shadow-card",
					)}
				>
					{a.name}
					<span className="text-xs text-muted-foreground">{a.currency}</span>
				</Link>
			))}
			{adding ? (
				<NewAccount onDone={() => setAdding(accounts.length === 0)} />
			) : (
				<Button variant="ghost" onClick={() => setAdding(true)}>
					<Plus />
					Account
				</Button>
			)}
		</div>
	);
}

function NewAccount({ onDone }: { onDone: () => void }) {
	const navigate = useNavigate();
	const form = useRef<HTMLFormElement>(null);
	const nameField = useRef<HTMLInputElement>(null);
	useEffect(() => nameField.current?.focus(), []);
	const [name, setName] = useState("");
	const [currency, setCurrency] = useState("USD");
	const [problem, setProblem] = useState<string | null>(null);
	const [saving, setSaving] = useState(false);

	async function submit(e: FormEvent) {
		e.preventDefault();
		if (saving) return;
		setSaving(true);
		const r = await optimism.change({
			send: () => newBankAccount({ data: { name, currency } }),
		});
		setSaving(false);
		if (!r) return;
		if (!r.value.ok) {
			setProblem(r.value.problem);
			shake(form.current);
			return;
		}
		setProblem(null);
		setName("");
		onDone();
		navigate({ to: "/reconciliation", search: { account: r.value.value.id } });
	}

	return (
		<form
			ref={form}
			onSubmit={submit}
			className="flex flex-wrap items-center gap-2"
		>
			<input
				ref={nameField}
				value={name}
				onChange={(e) => setName(e.target.value)}
				placeholder="Account name"
				aria-invalid={problem !== null}
				maxLength={80}
				className={cn(box, "w-48")}
			/>
			<input
				value={currency}
				onChange={(e) =>
					setCurrency(e.target.value.toUpperCase().replace(/[^A-Z]/g, ""))
				}
				aria-label="Currency"
				aria-invalid={problem !== null}
				maxLength={3}
				className={cn(box, "w-16 text-center uppercase")}
			/>
			<Button
				type="submit"
				disabled={saving || name.trim() === "" || currency.length !== 3}
			>
				{saving && <Loader2 className="animate-spin" />}
				Add
			</Button>
			{problem && <span className="text-xs text-critical-text">{problem}</span>}
		</form>
	);
}
