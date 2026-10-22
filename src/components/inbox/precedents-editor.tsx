import { useRouter } from "@tanstack/react-router";
import { Plus, Scale, Trash2 } from "lucide-react";
import { useRef, useState } from "react";
import { toast } from "sonner";
import type { Precedent } from "#/buyers/precedents";
import { EmptyState } from "#/components/page";
import { shake } from "#/components/shake";
import { Button } from "#/components/ui/button";
import { Tip } from "#/components/ui/tooltip";
import { offerUndo } from "#/lib/undo";
import { cn } from "#/lib/utils";
import {
	deletePrecedentFn,
	restorePrecedentFn,
	savePrecedentFn,
} from "#/server/buyer-drafts";

// What staff decided for each kind of case, which the reply agent follows:
// when this, then that. Each saves as it's left; a new one starts at the
// top.

export function PrecedentsEditor({ precedents }: { precedents: Precedent[] }) {
	const router = useRouter();
	const [adding, setAdding] = useState(false);
	const [gone, setGone] = useState<Set<number>>(new Set());
	const shown = precedents.filter((p) => !gone.has(p.id));

	async function remove(p: Precedent) {
		setGone((g) => new Set(g).add(p.id));
		try {
			await deletePrecedentFn({ data: { id: p.id } });
		} catch (error) {
			setGone((g) => {
				const next = new Set(g);
				next.delete(p.id);
				return next;
			});
			toast.error("Couldn't delete it", {
				description: error instanceof Error ? error.message : String(error),
			});
			return;
		}
		offerUndo("Deleted", {
			undo: async () => {
				await restorePrecedentFn({ data: p });
				await router.invalidate();
				setGone((g) => {
					const next = new Set(g);
					next.delete(p.id);
					return next;
				});
				return "Put back";
			},
		});
		await router.invalidate();
	}

	return (
		<div className="flex flex-col gap-3 p-4">
			<div className="flex items-center">
				<Button size="sm" onClick={() => setAdding(true)} disabled={adding}>
					<Plus />
					New precedent
				</Button>
			</div>
			{adding && (
				<Row
					key="new"
					precedent={null}
					onSaved={async () => {
						setAdding(false);
						await router.invalidate();
					}}
					onCancel={() => setAdding(false)}
				/>
			)}
			{shown.length === 0 && !adding ? (
				<EmptyState icon={Scale} title="No precedents yet" />
			) : (
				[...shown]
					.reverse()
					.map((p) => (
						<Row
							key={p.id}
							precedent={p}
							onSaved={() => router.invalidate()}
							onDelete={() => remove(p)}
						/>
					))
			)}
		</div>
	);
}

function Row({
	precedent: p,
	onSaved,
	onDelete,
	onCancel,
}: {
	precedent: Precedent | null;
	onSaved: () => void | Promise<void>;
	onDelete?: () => void;
	onCancel?: () => void;
}) {
	const [when, setWhen] = useState(p?.when ?? "");
	const [action, setAction] = useState(p?.action ?? "");
	const [state, setState] = useState<"idle" | "saving" | "saved" | "error">(
		"idle",
	);
	const card = useRef<HTMLFieldSetElement>(null);
	const started = useRef(false);
	const changed =
		when.trim() !== (p?.when ?? "") || action.trim() !== (p?.action ?? "");

	async function save() {
		if (!changed) return;
		if (when.trim().length < 3 || action.trim().length < 3) {
			// A new one half written waits; a saved one shakes back.
			if (p) {
				shake(card.current);
				setWhen(p.when);
				setAction(p.action);
			}
			return;
		}
		setState("saving");
		try {
			await savePrecedentFn({
				data: { id: p?.id ?? null, precedent: { when, action } },
			});
			setState("saved");
			await onSaved();
		} catch (error) {
			setState("error");
			shake(card.current);
			toast.error("Couldn't save it", {
				description: error instanceof Error ? error.message : String(error),
			});
		}
	}

	const field =
		"w-full resize-none rounded-lg border bg-background px-3 py-2 outline-none focus:ring-2 focus:ring-ring";
	return (
		<fieldset
			ref={card}
			onBlur={(e) => {
				// Saved once focus leaves the whole card, not between its fields.
				if (!e.currentTarget.contains(e.relatedTarget as Node)) void save();
			}}
			onKeyDown={(e) => {
				if (e.key === "Escape" && !p) onCancel?.();
			}}
			className={cn(
				"grid min-w-0 gap-2 rounded-xl border p-3 transition-colors md:grid-cols-[1fr_1.5fr_auto]",
				state === "saved" && "border-success-text/50",
				state === "error" && "border-critical-text",
				state === "saving" && "opacity-70",
			)}
		>
			<label className="flex flex-col gap-1">
				<span className="text-xs font-semibold text-muted-foreground">
					When
				</span>
				<textarea
					ref={(el) => {
						// A new one starts here.
						if (!p && el && !started.current) {
							started.current = true;
							el.focus();
						}
					}}
					value={when}
					rows={2}
					onChange={(e) => setWhen(e.target.value)}
					placeholder="The buyer says the box arrived empty"
					className={field}
				/>
			</label>
			<label className="flex flex-col gap-1">
				<span className="text-xs font-semibold text-muted-foreground">
					Then
				</span>
				<textarea
					value={action}
					rows={Math.max(2, action.split("\n").length)}
					onChange={(e) => setAction(e.target.value)}
					placeholder="Apologise, ship another today, no return needed"
					className={field}
				/>
			</label>
			<div className="flex items-start gap-1 md:flex-col md:items-end md:pt-5">
				{p?.by === "claude" && (
					<span className="rounded-md bg-surface-strong px-1.5 py-0.5 text-xs text-muted-foreground">
						Claude
					</span>
				)}
				{onDelete && (
					<Tip content="Delete">
						<Button
							size="sm"
							variant="ghost"
							aria-label="Delete"
							onClick={onDelete}
						>
							<Trash2 />
						</Button>
					</Tip>
				)}
			</div>
		</fieldset>
	);
}
