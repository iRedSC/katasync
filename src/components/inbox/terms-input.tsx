import { X } from "lucide-react";
import { useState } from "react";
import { cn } from "#/lib/utils";

// Words and phrases as chips: Enter or a comma adds what's typed (a paste
// with commas adds each), Backspace in the empty field takes the last back
// to edit, and a chip's × removes it.
export function TermsInput({
	terms,
	onChange,
	placeholder,
	invalid,
}: {
	terms: string[];
	onChange: (terms: string[]) => void;
	placeholder: string;
	invalid?: boolean;
}) {
	const [typing, setTyping] = useState("");
	const add = (text: string) => {
		const more = text
			.split(",")
			.map((t) => t.trim().toLowerCase())
			.filter((t) => t && !terms.includes(t));
		if (more.length > 0) onChange([...terms, ...new Set(more)]);
		setTyping("");
	};
	return (
		<div
			className={cn(
				"flex min-h-9 flex-1 flex-wrap items-center gap-1 rounded-lg border border-input bg-white px-1.5 py-1 focus-within:border-ring",
				invalid && "border-critical-border",
			)}
		>
			{terms.map((t) => (
				<span
					key={t}
					className="inline-flex h-6 items-center gap-0.5 rounded-md bg-surface-strong pr-0.5 pl-2 text-sm animate-in fade-in-0 zoom-in-95"
				>
					{t}
					<button
						type="button"
						aria-label={`Remove ${t}`}
						onClick={() => onChange(terms.filter((x) => x !== t))}
						className="rounded p-0.5 text-muted-foreground hover:bg-surface hover:text-foreground"
					>
						<X className="size-3" />
					</button>
				</span>
			))}
			<input
				value={typing}
				placeholder={terms.length === 0 ? placeholder : undefined}
				onChange={(e) => {
					const v = e.target.value;
					if (v.includes(",")) add(v);
					else setTyping(v);
				}}
				onKeyDown={(e) => {
					if (e.key === "Enter") {
						e.preventDefault();
						add(typing);
					} else if (e.key === "Backspace" && typing === "" && terms.length) {
						e.preventDefault();
						setTyping(terms.at(-1) ?? "");
						onChange(terms.slice(0, -1));
					}
				}}
				onBlur={() => add(typing)}
				className="h-6 min-w-24 flex-1 bg-transparent px-1 outline-none"
			/>
		</div>
	);
}
