import { LoaderCircle } from "lucide-react";
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
// Picking one hands over the lookup of the whole address to fill the other
// fields with. The caller decides whether it still applies.
export function AddressInput({
	name,
	defaultValue,
	className,
	onPick,
}: {
	name: string;
	defaultValue: string;
	className?: string;
	onPick: (address: Promise<PlaceAddress>) => Promise<void>;
}) {
	const listId = useId();
	const [query, setQuery] = useState("");
	const [options, setOptions] = useState<PlaceSuggestion[]>([]);
	const [active, setActive] = useState(0);
	const [open, setOpen] = useState(false);
	// From the first keystroke, debounce included, so the list shows at once.
	const [loading, setLoading] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const session = useRef(crypto.randomUUID());
	// A picked address being looked up. Only the latest pick's result counts.
	const [picking, setPicking] = useState(false);
	const picks = useRef(0);

	useEffect(() => {
		if (query.trim().length < 3) {
			setOptions([]);
			setLoading(false);
			return;
		}
		setLoading(true);
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
			} finally {
				if (current) setLoading(false);
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
		const ticket = ++picks.current;
		setPicking(true);
		try {
			await onPick(
				placeAddress({
					data: { placeId: option.placeId, sessionToken: session.current },
				}),
			);
		} catch (err) {
			toast.error(err instanceof Error ? err.message : String(err));
		}
		if (ticket === picks.current) setPicking(false);
		session.current = crypto.randomUUID();
	}

	const typed = query.trim();
	// Open while typing, even before there's anything to pick, so it's clear
	// the field searches.
	const listOpen = open && typed !== "";
	// Options from the last search stay hidden, and unpickable, while the next
	// one runs.
	const showing = listOpen && !loading && options.length > 0;
	const status =
		typed.length < 3
			? "Keep typing…"
			: loading
				? "Searching…"
				: error
					? null
					: options.length === 0
						? "No matches"
						: null;
	const visible = listOpen && (status !== null || showing);
	return (
		<div className="relative">
			<input
				name={name}
				defaultValue={defaultValue}
				autoComplete="off"
				role="combobox"
				aria-expanded={visible}
				aria-controls={listId}
				aria-activedescendant={showing ? `${listId}-${active}` : undefined}
				onChange={(e) => {
					setQuery(e.target.value);
					setOpen(true);
				}}
				onBlur={() => setOpen(false)}
				onKeyDown={(e) => {
					if (!visible) return;
					if (e.key === "Escape") {
						// The dialog leaves Esc alone while this list is open.
						setOpen(false);
					} else if (!showing) {
						// Not a submit while the list is up with nothing to pick.
						if (e.key === "Enter") e.preventDefault();
					} else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
						e.preventDefault();
						const step = e.key === "ArrowDown" ? 1 : -1;
						setActive((i) => (i + step + options.length) % options.length);
					} else if (e.key === "Enter") {
						e.preventDefault();
						pick(options[active]);
					}
				}}
				className={cn(className, "pr-7")}
			/>
			{(loading || picking) && (
				<LoaderCircle
					aria-hidden
					className="pointer-events-none absolute top-2 right-2 size-4 animate-spin text-muted-foreground"
				/>
			)}
			{visible && (
				<div
					id={listId}
					role="listbox"
					aria-busy={loading}
					className="absolute inset-x-0 top-full z-10 mt-1 overflow-hidden rounded-lg border bg-white shadow-lg"
				>
					{status && (
						<div className="flex items-center gap-2 px-2 py-1.5 text-muted-foreground">
							{loading && <LoaderCircle className="size-3.5 animate-spin" />}
							{status}
						</div>
					)}
					{showing &&
						options.map((o, i) => (
							// Focus stays in the input; aria-activedescendant points here.
							<div
								key={o.placeId}
								id={`${listId}-${i}`}
								role="option"
								tabIndex={-1}
								aria-selected={i === active}
								// Mouse down, not click, so the input keeps focus.
								onMouseDown={(e) => {
									e.preventDefault();
									pick(o);
								}}
								onMouseEnter={() => setActive(i)}
								className={cn(
									"cursor-pointer px-2 py-1.5",
									i === active && "bg-surface",
								)}
							>
								<span className="font-medium">{o.main}</span>
								{o.rest && (
									<span className="text-muted-foreground"> {o.rest}</span>
								)}
							</div>
						))}
				</div>
			)}
			{error && (
				<p className="mt-1 text-xs text-critical-text">
					Address lookup failed: {error}
				</p>
			)}
		</div>
	);
}
