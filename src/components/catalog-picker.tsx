import { Check, ChevronDown, Plus, X } from "lucide-react";
import { useState } from "react";
import { CatalogMark } from "#/components/catalog-mark";
import {
	Command,
	CommandEmpty,
	CommandGroup,
	CommandInput,
	CommandItem,
	CommandList,
} from "#/components/ui/command";
import {
	Popover,
	PopoverContent,
	PopoverTrigger,
} from "#/components/ui/popover";
import { cn } from "#/lib/utils";

type Option = {
	id: number;
	name: string;
	// Unknown where the caller has only the name; shows as initials then.
	photoId?: number | null;
	description?: string | null;
};

const mark = (c: Option) => ({ name: c.name, photoId: c.photoId ?? null });

// A catalog as a search row: its mark, name, and what it's about, which
// the search matches too.
export function CatalogOption({ c }: { c: Option }) {
	return (
		<>
			<CatalogMark catalog={mark(c)} />
			<span className="flex min-w-0 flex-1 flex-col">
				<span className="truncate">{c.name}</span>
				{c.description && (
					<span className="truncate text-xs text-muted-foreground">
						{c.description}
					</span>
				)}
			</span>
		</>
	);
}

// One catalog, picked from a search, or typed to make a new one. Picking
// "No catalog" takes the product out of any.
export function CatalogSelect({
	value,
	catalogs,
	onPick,
	onMake,
	disabled,
	placeholder = "No catalog",
	onOpen,
}: {
	value: Option | null;
	catalogs: Option[] | null;
	onPick: (catalog: Option | null) => void;
	onMake: (name: string) => void;
	disabled?: boolean;
	// What it reads as with nothing picked.
	placeholder?: string;
	// When it opens, e.g. to load the catalogs.
	onOpen?: () => void;
}) {
	const [open, setOpen] = useState(false);
	const [text, setText] = useState("");
	const typed = text.trim();
	const exists = catalogs?.some(
		(c) => c.name.toLowerCase() === typed.toLowerCase(),
	);
	const done = () => {
		setOpen(false);
		setText("");
	};
	return (
		<Popover
			open={open}
			onOpenChange={(o) => {
				setOpen(o);
				if (o) onOpen?.();
			}}
		>
			<PopoverTrigger asChild>
				<button
					type="button"
					disabled={disabled}
					className={cn(
						"inline-flex h-7 max-w-full items-center gap-1 rounded-md border border-input bg-white px-2 font-medium hover:border-ring",
						value === null && "text-muted-foreground",
					)}
				>
					{value && <CatalogMark catalog={mark(value)} size="xs" />}
					<span className="truncate">{value?.name ?? placeholder}</span>
					<ChevronDown className="size-3.5 shrink-0 text-muted-foreground" />
				</button>
			</PopoverTrigger>
			<PopoverContent className="w-72 p-0" align="start">
				<Command>
					<CommandInput
						placeholder="Find or name a catalog"
						value={text}
						onValueChange={setText}
					/>
					<CommandList>
						<CommandEmpty>
							{catalogs === null ? "Loading…" : "No catalog by that name"}
						</CommandEmpty>
						{typed !== "" && !exists && (
							<CommandGroup>
								<CommandItem
									value={`new ${typed}`}
									onSelect={() => {
										done();
										onMake(typed);
									}}
								>
									<Plus />
									Make "{typed}"
								</CommandItem>
							</CommandGroup>
						)}
						<CommandGroup>
							{catalogs?.map((c) => (
								<CommandItem
									key={c.id}
									value={c.name}
									keywords={c.description ? [c.description] : undefined}
									onSelect={() => {
										done();
										if (c.id !== value?.id) onPick(c);
									}}
								>
									<CatalogOption c={c} />
									<Check className={cn(c.id !== value?.id && "invisible")} />
								</CommandItem>
							))}
							{value !== null && (
								<CommandItem
									value="no catalog"
									onSelect={() => {
										done();
										onPick(null);
									}}
									className="text-muted-foreground"
								>
									<X />
									No catalog
								</CommandItem>
							)}
						</CommandGroup>
					</CommandList>
				</Command>
			</PopoverContent>
		</Popover>
	);
}

// Several catalogs as chips, more picked from a search. Taking off the last
// one isn't allowed: something has to be in.
export function CatalogChips({
	value,
	catalogs,
	onChange,
}: {
	value: number[];
	catalogs: Option[];
	onChange: (ids: number[]) => void;
}) {
	const [open, setOpen] = useState(false);
	const chosen = catalogs.filter((c) => value.includes(c.id));
	const rest = catalogs.filter((c) => !value.includes(c.id));
	return (
		<div className="flex min-h-9 flex-wrap items-center gap-1 rounded-lg border border-input bg-white px-1.5 py-1">
			{chosen.map((c) => (
				<span
					key={c.id}
					className="inline-flex items-center gap-1 rounded-md bg-subtle py-0.5 pr-0.5 pl-1 text-sm"
				>
					<CatalogMark catalog={mark(c)} size="xs" />
					{c.name}
					{chosen.length > 1 && (
						<button
							type="button"
							aria-label={`Leave out ${c.name}`}
							onClick={() => onChange(value.filter((id) => id !== c.id))}
							className="rounded p-0.5 text-muted-foreground hover:bg-surface-strong hover:text-foreground"
						>
							<X className="size-3" />
						</button>
					)}
				</span>
			))}
			{rest.length > 0 && (
				<Popover open={open} onOpenChange={setOpen}>
					<PopoverTrigger asChild>
						<button
							type="button"
							className="inline-flex h-6 items-center gap-1 rounded-md px-1.5 text-sm text-muted-foreground hover:bg-subtle hover:text-foreground"
						>
							<Plus className="size-3.5" />
							{rest.length} more
						</button>
					</PopoverTrigger>
					<PopoverContent className="w-60 p-0" align="start">
						<Command>
							<CommandInput placeholder="Catalog" />
							<CommandList>
								<CommandEmpty>None left</CommandEmpty>
								<CommandGroup>
									{rest.map((c) => (
										<CommandItem
											key={c.id}
											value={c.name}
											keywords={c.description ? [c.description] : undefined}
											onSelect={() => {
												onChange([...value, c.id]);
												if (rest.length === 1) setOpen(false);
											}}
										>
											<CatalogOption c={c} />
										</CommandItem>
									))}
								</CommandGroup>
							</CommandList>
						</Command>
					</PopoverContent>
				</Popover>
			)}
		</div>
	);
}
