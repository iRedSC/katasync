import { Search, UserPlus } from "lucide-react";
import { useEffect, useState } from "react";
import { formatPhone } from "#/lib/format";
import { cn } from "#/lib/utils";
import { findCustomers } from "#/server/repairs";

// Finds a Shopify customer by name, phone, or email as it's typed, or
// starts a new one from what was typed: digits become the phone, words
// the name.

export type FoundCustomer = Awaited<ReturnType<typeof findCustomers>>[number];

export type NewCustomer = {
	firstName: string;
	lastName: string;
	phone: string | null;
	email: string | null;
};

// What was typed, as a new customer's first guess.
export function guessNew(text: string): NewCustomer {
	const t = text.trim();
	if (/^[\d\s()+.-]+$/.test(t) && t !== "")
		return { firstName: "", lastName: "", phone: t, email: null };
	if (t.includes("@"))
		return { firstName: "", lastName: "", phone: null, email: t };
	const [first = "", ...rest] = t.split(/\s+/);
	return {
		firstName: first,
		lastName: rest.join(" "),
		phone: null,
		email: null,
	};
}

// `again` changing searches again for the same words.
export function useCustomerSearch(query: string, again = 0) {
	const [found, setFound] = useState<FoundCustomer[] | null>(null);
	const [error, setError] = useState<string | null>(null);
	// biome-ignore lint/correctness/useExhaustiveDependencies: again only asks for a fresh search
	useEffect(() => {
		let current = true;
		const timer = setTimeout(() => {
			findCustomers({ data: { q: query } }).then(
				(list) => {
					if (!current) return;
					setFound(list);
					setError(null);
				},
				(e: unknown) =>
					current && setError(e instanceof Error ? e.message : String(e)),
			);
		}, 200);
		return () => {
			current = false;
			clearTimeout(timer);
		};
	}, [query, again]);
	return { found, error };
}

export function CustomerPicker({
	onPick,
	onNew,
	autoFocus = true,
}: {
	onPick: (c: FoundCustomer) => void;
	onNew: (guess: NewCustomer) => void;
	autoFocus?: boolean;
}) {
	const [query, setQuery] = useState("");
	const [active, setActive] = useState(0);
	const { found, error } = useCustomerSearch(query);
	const list = (found ?? []).slice(0, 6);
	// The last row starts a new customer from what was typed.
	const rows = list.length + 1;

	return (
		<div className="overflow-hidden rounded-lg border border-input">
			<div className="flex items-center gap-2 px-3 py-2">
				<Search className="size-4 text-muted-foreground" />
				<input
					// biome-ignore lint/a11y/noAutofocus: the first thing asked when a tool comes in
					autoFocus={autoFocus}
					value={query}
					onChange={(e) => {
						setQuery(e.target.value);
						setActive(0);
					}}
					onKeyDown={(e) => {
						if (e.key === "ArrowDown")
							setActive((a) => Math.min(a + 1, rows - 1));
						if (e.key === "ArrowUp") setActive((a) => Math.max(a - 1, 0));
						if (e.key === "Enter") {
							e.preventDefault();
							const c = list[active];
							if (c) onPick(c);
							else onNew(guessNew(query));
						}
					}}
					placeholder="Phone number or name"
					className="w-full bg-transparent outline-none"
				/>
			</div>
			<ul className="border-t">
				{error && <li className="px-3 py-2 text-critical-text">{error}</li>}
				{list.map((c, i) => (
					<li key={c.id}>
						<button
							type="button"
							onClick={() => onPick(c)}
							onMouseEnter={() => setActive(i)}
							className={cn(
								"flex w-full items-center gap-3 px-3 py-2 text-left",
								i === active && "bg-subtle",
							)}
						>
							<span className="min-w-0 flex-1 truncate font-medium">
								{c.name}
							</span>
							<span className="text-muted-foreground tabular-nums">
								{c.phone ? formatPhone(c.phone) : c.email}
							</span>
							{c.openRepairs > 0 && (
								<span className="text-xs text-info-text">
									{c.openRepairs} in shop
								</span>
							)}
						</button>
					</li>
				))}
				<li>
					<button
						type="button"
						onClick={() => onNew(guessNew(query))}
						onMouseEnter={() => setActive(list.length)}
						className={cn(
							"flex w-full items-center gap-2 px-3 py-2 text-left text-link",
							active === list.length && "bg-subtle",
						)}
					>
						<UserPlus className="size-4 shrink-0" />
						<span className="truncate">
							{query.trim() ? `New customer: ${query.trim()}` : "New customer"}
						</span>
					</button>
				</li>
			</ul>
		</div>
	);
}

export function CustomerFields({
	value,
	onChange,
}: {
	value: NewCustomer;
	onChange: (v: NewCustomer) => void;
}) {
	const field = (
		key: keyof NewCustomer,
		placeholder: string,
		extra?: object,
	) => (
		<input
			value={value[key] ?? ""}
			placeholder={placeholder}
			onChange={(e) => onChange({ ...value, [key]: e.target.value })}
			className="h-9 w-full rounded-lg border border-input bg-white px-3 outline-none focus:border-ring"
			{...extra}
		/>
	);
	return (
		<div className="grid grid-cols-2 gap-2">
			{field("firstName", "First name", { autoFocus: !value.firstName })}
			{field("lastName", "Last name")}
			{field("phone", "Phone", {
				inputMode: "tel",
				autoFocus: !!value.firstName && !value.phone,
			})}
			{field("email", "Email (for invoices)", { type: "email" })}
		</div>
	);
}
