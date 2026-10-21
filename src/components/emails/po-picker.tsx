import { ChevronDown } from "lucide-react";
import { useState } from "react";
import { Button } from "#/components/ui/button";
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
import { formatDate } from "#/lib/format";
import type { InboxPage } from "#/purchasing/inbox/views";

type Po = InboxPage["pos"][number];

// The likely POs as buttons, and every other recent one a search away.
export function PoPicker({
	pos,
	likely,
	onPick,
	label = "Link to PO",
}: {
	pos: Po[];
	likely: number[];
	onPick: (po: number) => void;
	label?: string;
}) {
	const [open, setOpen] = useState(false);
	const byId = new Map(pos.map((p) => [p.id, p]));
	const first = likely.flatMap((id) => byId.get(id) ?? []);
	const rest = pos.filter((p) => !likely.includes(p.id));
	const pick = (id: number) => {
		setOpen(false);
		onPick(id);
	};
	const item = (p: Po) => (
		<CommandItem
			key={p.id}
			value={`${p.id} ${p.supplier}`}
			onSelect={() => pick(p.id)}
		>
			<span className="font-medium tabular-nums">PO {p.id}</span>
			<span className="truncate">{p.supplier}</span>
			{p.sentAt && (
				<span className="ml-auto shrink-0 text-xs text-muted-foreground">
					{formatDate(p.sentAt)}
				</span>
			)}
		</CommandItem>
	);

	return (
		<>
			{first.slice(0, 3).map((p) => (
				<Button key={p.id} size="sm" onClick={() => pick(p.id)}>
					PO {p.id}
					<span className="font-normal opacity-80">{p.supplier}</span>
				</Button>
			))}
			<Popover open={open} onOpenChange={setOpen}>
				<PopoverTrigger asChild>
					<Button size="sm" variant="outline">
						{first.length > 0 ? "Other PO" : label}
						<ChevronDown />
					</Button>
				</PopoverTrigger>
				<PopoverContent className="w-80 p-0" align="start">
					<Command>
						<CommandInput placeholder="PO number or supplier" />
						<CommandList>
							<CommandEmpty>No sent PO matches</CommandEmpty>
							{first.length > 0 && (
								<CommandGroup heading="Likely">{first.map(item)}</CommandGroup>
							)}
							<CommandGroup heading="Sent in the last 6 months">
								{rest.map(item)}
							</CommandGroup>
						</CommandList>
					</Command>
				</PopoverContent>
			</Popover>
		</>
	);
}
