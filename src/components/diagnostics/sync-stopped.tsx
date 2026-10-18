import { AlertCircle } from "lucide-react";
import {
	Popover,
	PopoverContent,
	PopoverTrigger,
} from "#/components/ui/popover";
import { formatDateTime } from "#/lib/format";
import { copy } from "./blocks";

// The worker being down stops everything else on the page, so it sits in the
// header, opening to what to run.
export function SyncStopped({ lastStartedAt }: { lastStartedAt: Date | null }) {
	return (
		<Popover>
			<PopoverTrigger className="inline-flex h-8 items-center gap-1.5 rounded-lg bg-critical-fill px-2.5 font-medium text-critical-text">
				<AlertCircle className="size-4" />
				Order sync stopped
			</PopoverTrigger>
			<PopoverContent className="w-80 p-3">
				<p>
					{lastStartedAt
						? `Last sync ${formatDateTime(lastStartedAt)}. `
						: "Never synced. "}
					On the katasync machine, run:
				</p>
				<button
					type="button"
					onClick={() => copy("pnpm sync --watch")}
					className="mt-2 w-full rounded-md bg-subtle px-2 py-1 text-left font-mono hover:bg-surface-strong"
				>
					pnpm sync --watch
				</button>
			</PopoverContent>
		</Popover>
	);
}
