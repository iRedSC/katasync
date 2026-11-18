import { X } from "lucide-react";
import { type Ref, useImperativeHandle, useRef, useState } from "react";
import { shake } from "#/components/shake";
import { cn } from "#/lib/utils";
import {
	cleanContacts,
	contactProblems,
	type SupplierContact,
} from "#/purchasing/contacts";

type Row = { key: number; name: string; email: string };

export type ContactsHandle = {
	// The contacts ready to save, or null after showing what's wrong.
	check: () => SupplierContact[] | null;
};

let nextKey = 0;
const row = (c?: SupplierContact): Row => ({
	key: nextKey++,
	name: c?.name ?? "",
	email: c?.email ?? "",
});

// A blank row always waits at the bottom, so adding a contact is just typing.
const withBlank = (rows: Row[]) => {
	const last = rows.at(-1);
	return last && last.name === "" && last.email === ""
		? rows
		: [...rows, row()];
};

// Everyone a supplier's emails go to, one row each. A row's problem shows
// once its email is left, or once a save is tried; saving shakes the first
// bad row.
export function SupplierContactsInput({
	defaultValue,
	onChange,
	handle,
	className,
}: {
	defaultValue: readonly SupplierContact[];
	onChange: (rows: { name: string; email: string }[]) => void;
	handle: Ref<ContactsHandle>;
	className: string;
}) {
	const [rows, setRows] = useState(() => withBlank(defaultValue.map(row)));
	const [shown, setShown] = useState<"touched" | "all">("touched");
	const [touched, setTouched] = useState(new Set<number>());
	const list = useRef<HTMLDivElement>(null);
	const problems = contactProblems(rows);
	const visible = (i: number) =>
		problems[i] !== null &&
		(shown === "all" || touched.has(rows[i].key)) &&
		i < rows.length - 1;

	useImperativeHandle(handle, () => ({
		check() {
			const bad = problems.findIndex((p) => p !== null);
			if (bad < 0) return cleanContacts(rows);
			setShown("all");
			shake(
				list.current?.querySelector<HTMLElement>(`[data-row="${bad}"]`) ?? null,
			);
			return null;
		},
	}));

	function set(next: Row[]) {
		const filled = withBlank(next);
		setRows(filled);
		onChange(filled);
	}
	const edit = (i: number, change: Partial<Row>) =>
		set(rows.map((r, n) => (n === i ? { ...r, ...change } : r)));

	return (
		<div ref={list} className="flex flex-col gap-1.5">
			{rows.map((r, i) => {
				const bad = visible(i);
				const last = i === rows.length - 1;
				return (
					<div key={r.key} data-row={i} className="flex flex-col gap-0.5">
						<div className="grid grid-cols-[minmax(0,2fr)_minmax(0,3fr)_1.75rem] gap-1.5">
							<input
								aria-label="Contact name"
								placeholder="Name"
								value={r.name}
								autoComplete="off"
								onChange={(e) => edit(i, { name: e.target.value })}
								className={className}
							/>
							<input
								aria-label="Contact email"
								type="email"
								placeholder={i === 0 ? "orders@supplier.com" : "Email"}
								value={r.email}
								autoComplete="off"
								aria-invalid={bad}
								onChange={(e) => edit(i, { email: e.target.value })}
								onBlur={() => setTouched((t) => new Set(t).add(r.key))}
								className={className}
							/>
							{!last && (
								<button
									type="button"
									aria-label={`Remove ${r.name || r.email || "contact"}`}
									onClick={() => set(rows.filter((_, n) => n !== i))}
									className="flex items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
								>
									<X className="size-4" />
								</button>
							)}
						</div>
						<span
							className={cn("text-xs text-critical-text", !bad && "hidden")}
						>
							{problems[i]}
						</span>
					</div>
				);
			})}
		</div>
	);
}
