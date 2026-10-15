import { useEffect, useId, useRef, useState } from "react";
import { toast } from "sonner";
import { cn } from "#/lib/utils";
import {
	type PlaceAddress,
	type PlaceSuggestion,
	placeAddress,
	suggestPlaces,
} from "#/server/places";

// A street address field that suggests addresses and businesses as you type.
// Picking one hands back the whole address to fill the other fields with.
export function AddressInput({
	name,
	defaultValue,
	className,
	onPick,
}: {
	name: string;
	defaultValue: string;
	className?: string;
	onPick: (address: PlaceAddress) => void;
}) {
	const listId = useId();
	const [query, setQuery] = useState("");
	const [options, setOptions] = useState<PlaceSuggestion[]>([]);
	const [active, setActive] = useState(0);
	const [open, setOpen] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const session = useRef(crypto.randomUUID());

	useEffect(() => {
		if (query.trim().length < 3) {
			setOptions([]);
			return;
		}
		let current = true;
		const timer = setTimeout(async () => {
			try {
				const found = await suggestPlaces({
					data: { input: query, sessionToken: session.current },
				});
				if (!current) return;
				setOptions(found);
				setActive(0);
				setError(null);
			} catch (err) {
				if (current) setError(err instanceof Error ? err.message : String(err));
			}
		}, 250);
		return () => {
			current = false;
			clearTimeout(timer);
		};
	}, [query]);

	async function pick(option: PlaceSuggestion) {
		setOpen(false);
		setOptions([]);
		try {
			onPick(
				await placeAddress({
					data: { placeId: option.placeId, sessionToken: session.current },
				}),
			);
		} catch (err) {
			toast.error(err instanceof Error ? err.message : String(err));
		}
		session.current = crypto.randomUUID();
	}

	const showing = open && options.length > 0;
	return (
		<div className="relative">
			<input
				name={name}
				defaultValue={defaultValue}
				autoComplete="off"
				role="combobox"
				aria-expanded={showing}
				aria-controls={listId}
				aria-activedescendant={showing ? `${listId}-${active}` : undefined}
				onChange={(e) => {
					setQuery(e.target.value);
					setOpen(true);
				}}
				onBlur={() => setOpen(false)}
				onKeyDown={(e) => {
					if (!showing) return;
					if (e.key === "ArrowDown" || e.key === "ArrowUp") {
						e.preventDefault();
						const step = e.key === "ArrowDown" ? 1 : -1;
						setActive((i) => (i + step + options.length) % options.length);
					} else if (e.key === "Enter") {
						e.preventDefault();
						pick(options[active]);
					} else if (e.key === "Escape") {
						// The dialog leaves Esc alone while this list is open.
						setOpen(false);
					}
				}}
				className={className}
			/>
			{showing && (
				<ul
					id={listId}
					role="listbox"
					className="absolute inset-x-0 top-full z-10 mt-1 overflow-hidden rounded-lg border bg-white shadow-lg"
				>
					{options.map((o, i) => (
						<li
							key={o.placeId}
							id={`${listId}-${i}`}
							role="option"
							aria-selected={i === active}
							// Mouse down, not click, so the input keeps focus.
							onMouseDown={(e) => {
								e.preventDefault();
								pick(o);
							}}
							onMouseEnter={() => setActive(i)}
							className={cn(
								"cursor-pointer px-2 py-1.5",
								i === active && "bg-[#f1f1f1]",
							)}
						>
							<span className="font-medium">{o.main}</span>
							{o.rest && (
								<span className="text-muted-foreground"> {o.rest}</span>
							)}
						</li>
					))}
				</ul>
			)}
			{error && (
				<p className="mt-1 text-xs text-critical-text">
					Address lookup failed: {error}
				</p>
			)}
		</div>
	);
}
