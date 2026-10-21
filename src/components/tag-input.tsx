import { X } from "lucide-react";
import { type KeyboardEvent, useId, useState } from "react";
import { cn } from "#/lib/utils";

// Tags as chips, typed with the shop's own tags suggested as you go, so a
// tag is spelled the way the shop's collections and filters expect. Enter,
// Tab or a comma takes the highlighted suggestion (or what's typed);
// Backspace in an empty field takes the last tag off.
export function TagInput({
	value,
	onChange,
	suggestions,
}: {
	value: string[];
	onChange: (tags: string[]) => void;
	suggestions: string[];
}) {
	const [text, setText] = useState("");
	const [open, setOpen] = useState(false);
	const [active, setActive] = useState(0);
	const listId = useId();
	const q = text.trim().toLowerCase();
	const taken = new Set(value.map((t) => t.toLowerCase()));
	const matches = q
		? suggestions
				.filter((s) => !taken.has(s.toLowerCase()))
				.filter((s) => s.toLowerCase().includes(q))
				.sort(
					(a, b) =>
						Number(!a.toLowerCase().startsWith(q)) -
							Number(!b.toLowerCase().startsWith(q)) || a.localeCompare(b),
				)
				.slice(0, 8)
		: [];
	const shown = open && matches.length > 0;

	function add(tag: string) {
		const t = tag.trim();
		if (t && !taken.has(t.toLowerCase())) onChange([...value, t]);
		setText("");
		setActive(0);
	}

	function key(e: KeyboardEvent<HTMLInputElement>) {
		if (e.key === "ArrowDown" && shown) {
			e.preventDefault();
			setActive((i) => Math.min(i + 1, matches.length - 1));
		} else if (e.key === "ArrowUp" && shown) {
			e.preventDefault();
			setActive((i) => Math.max(i - 1, 0));
		} else if (
			(e.key === "Enter" || e.key === "," || (e.key === "Tab" && q)) &&
			q
		) {
			e.preventDefault();
			add(shown ? matches[active] : text);
		} else if (e.key === "Backspace" && !text && value.length > 0) {
			onChange(value.slice(0, -1));
		} else if (e.key === "Escape" && shown) {
			e.stopPropagation();
			setOpen(false);
		}
	}

	return (
		<div className="relative">
			<div className="flex min-h-8 w-full flex-wrap items-center gap-1 rounded-lg border border-input bg-white px-1.5 py-1 focus-within:border-ring">
				{value.map((tag) => (
					<span
						key={tag}
						className="inline-flex items-center gap-0.5 rounded-md bg-subtle py-0.5 pr-0.5 pl-2 text-sm"
					>
						{tag}
						<button
							type="button"
							aria-label={`Remove ${tag}`}
							onClick={() => onChange(value.filter((t) => t !== tag))}
							className="rounded p-0.5 text-muted-foreground hover:bg-surface-strong hover:text-foreground"
						>
							<X className="size-3" />
						</button>
					</span>
				))}
				<input
					value={text}
					onChange={(e) => {
						const typed = e.target.value;
						// A pasted list becomes tags at once.
						if (typed.includes(",")) {
							const parts = typed.split(",");
							const rest = parts.pop() ?? "";
							const next = [...value];
							for (const p of parts) {
								const t = p.trim();
								if (t && !next.some((v) => v.toLowerCase() === t.toLowerCase()))
									next.push(t);
							}
							onChange(next);
							setText(rest);
						} else setText(typed);
						setActive(0);
						setOpen(true);
					}}
					onKeyDown={key}
					onFocus={() => setOpen(true)}
					onBlur={() => {
						setOpen(false);
						if (q) add(text);
					}}
					role="combobox"
					aria-expanded={shown}
					aria-controls={listId}
					aria-label="Add a tag"
					className="h-6 min-w-24 flex-1 bg-transparent px-1 outline-none"
				/>
			</div>
			{shown && (
				<div
					id={listId}
					role="listbox"
					className="absolute z-10 mt-1 max-h-56 w-full overflow-auto rounded-lg border bg-white py-1 shadow-md"
				>
					{matches.map((m, i) => (
						<div
							key={m}
							role="option"
							tabIndex={-1}
							aria-selected={i === active}
							// Before the input's blur, which would take the typed text.
							onMouseDown={(e) => {
								e.preventDefault();
								add(m);
							}}
							onMouseMove={() => setActive(i)}
							className={cn(
								"cursor-pointer px-3 py-1",
								i === active && "bg-surface",
							)}
						>
							{m}
						</div>
					))}
				</div>
			)}
		</div>
	);
}
