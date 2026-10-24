import { Loader2, Upload } from "lucide-react";
import { useRef, useState } from "react";
import { toast } from "sonner";
import { shake } from "#/components/shake";
import { Button } from "#/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
} from "#/components/ui/dialog";
import { formatCount } from "#/lib/format";
import { useIntent } from "#/lib/intent";
import { optimism } from "#/lib/optimism";
import {
	importBankFile,
	peekBankFile,
	previewBankFile,
} from "#/server/banking";
import { ImportPreview } from "./import-preview";
import type { Draft, Step } from "./import-step";
import { MappingForm } from "./mapping-form";

const MAX_BYTES = 2_000_000;

export function ImportDialog({
	account,
	open,
	onOpenChange,
}: {
	account: { id: number; name: string; currency: string };
	open: boolean;
	onOpenChange: (open: boolean) => void;
}) {
	const [step, setStep] = useState<Step>({ kind: "source", problem: null });
	const [pasted, setPasted] = useState("");
	const run = useRef(0);
	const committing = useRef(false);
	const intent = useIntent<Parameters<typeof importBankFile>[0]["data"]>();
	const body = useRef<HTMLDivElement>(null);

	const reset = () => {
		run.current++;
		setStep({ kind: "source", problem: null });
		setPasted("");
	};
	const close = (next: boolean) => {
		if (!next && (committing.current || intent.getSnapshot().kind !== "idle")) {
			shake(body.current);
			return;
		}
		if (!next) reset();
		onOpenChange(next);
	};
	const refuse = (next: Step) => {
		setStep(next);
		shake(body.current);
	};

	async function read(text: string, fileName: string | null) {
		if (new TextEncoder().encode(text).length > MAX_BYTES)
			return refuse({ kind: "source", problem: "The file is over 2 MB" });
		const mine = ++run.current;
		setStep({ kind: "reading" });
		const r = await peekBankFile({ data: { text } }).catch((e: Error) => ({
			ok: false as const,
			problem: e.message,
		}));
		if (mine !== run.current) return;
		if (!r.ok) return refuse({ kind: "source", problem: r.problem });
		setStep({
			kind: "mapping",
			draft: { text, fileName, peek: r.value, mapping: r.value.guess },
			problem: null,
		});
	}

	async function preview(draft: Draft) {
		const mine = ++run.current;
		setStep({ kind: "previewing", draft });
		const r = await previewBankFile({
			data: {
				accountId: account.id,
				text: draft.text,
				fileName: draft.fileName,
				mapping: draft.mapping,
				replacesImportId: draft.replacesImportId,
			},
		}).catch((e: Error) => ({ ok: false as const, problem: e.message }));
		if (mine !== run.current) return;
		if (!r.ok) return refuse({ kind: "mapping", draft, problem: r.problem });
		setStep({
			kind: "preview",
			draft,
			preview: r.value,
			skip: new Set(),
			problem: null,
		});
	}

	async function commit(
		draft: Draft,
		skip: ReadonlySet<number>,
		keep: ReadonlySet<number>,
	) {
		if (
			committing.current ||
			(step.kind !== "preview" && step.kind !== "retry")
		)
			return;
		committing.current = true;
		const back = step;
		const mine = ++run.current;
		setStep({ kind: "importing", draft, preview: back.preview, skip });
		const r = await intent.run(
			() => ({
				accountId: account.id,
				text: draft.text,
				fileName: draft.fileName,
				mapping: draft.mapping,
				replacesImportId: draft.replacesImportId,
				skipRows: [...skip],
				keepRows: [...keep],
			}),
			(data) => optimism.change({ send: () => importBankFile({ data }) }),
		);
		committing.current = false;
		if (mine !== run.current) return;
		if (!r)
			return refuse({
				...back,
				kind: "retry",
				problem: "Result not received. Retry this import.",
			});
		if (!r.value.ok) return refuse({ ...back, problem: r.value.problem });
		const done = r.value.value;
		close(false);
		if (done.kind === "already") {
			toast("This file was already imported", {
				description: `Import #${done.importId}; nothing changed`,
			});
			return;
		}
		const extra = [
			done.skipped && `${formatCount(done.skipped)} left out`,
			done.duplicates && `${formatCount(done.duplicates)} already in`,
			done.invalid && `${formatCount(done.invalid)} unreadable`,
		].filter(Boolean);
		toast.success(
			`Added ${formatCount(done.added)} bank ${done.added === 1 ? "row" : "rows"}`,
			{
				description: extra.join(", ") || undefined,
			},
		);
	}

	return (
		<Dialog open={open} onOpenChange={close}>
			<DialogContent className="flex max-h-[90dvh] flex-col sm:max-w-4xl">
				<DialogHeader>
					<DialogTitle>Import bank CSV</DialogTitle>
					<DialogDescription>
						{account.name} · {account.currency}
					</DialogDescription>
				</DialogHeader>
				<div
					ref={body}
					className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto"
				>
					{step.kind === "source" || step.kind === "reading" ? (
						<Source
							busy={step.kind === "reading"}
							problem={step.kind === "source" ? step.problem : null}
							pasted={pasted}
							onPaste={setPasted}
							onRead={read}
						/>
					) : step.kind === "mapping" || step.kind === "previewing" ? (
						<MappingForm
							draft={step.draft}
							busy={step.kind === "previewing"}
							problem={step.kind === "mapping" ? step.problem : null}
							onChange={(mapping) =>
								step.kind === "mapping" &&
								setStep({
									...step,
									draft: { ...step.draft, mapping },
									problem: null,
								})
							}
							onBack={reset}
							onPreview={() => preview(step.draft)}
						/>
					) : (
						<ImportPreview
							currency={account.currency}
							preview={step.preview}
							skip={step.skip}
							problem={
								step.kind === "preview" || step.kind === "retry"
									? step.problem
									: null
							}
							busy={step.kind === "importing"}
							retry={step.kind === "retry"}
							onCorrect={() =>
								step.preview.alreadyImported !== null &&
								setStep({
									kind: "mapping",
									draft: {
										...step.draft,
										replacesImportId: step.preview.alreadyImported,
									},
									problem: null,
								})
							}
							onSkip={(skip) =>
								step.kind === "preview" &&
								setStep({ ...step, skip, problem: null })
							}
							onBack={() =>
								setStep({ kind: "mapping", draft: step.draft, problem: null })
							}
							onImport={(keep) =>
								(step.kind === "preview" || step.kind === "retry") &&
								commit(step.draft, step.skip, keep)
							}
						/>
					)}
				</div>
			</DialogContent>
		</Dialog>
	);
}

function Source({
	busy,
	problem,
	pasted,
	onPaste,
	onRead,
}: {
	busy: boolean;
	problem: string | null;
	pasted: string;
	onPaste: (text: string) => void;
	onRead: (text: string, fileName: string | null) => void;
}) {
	const picker = useRef<HTMLInputElement>(null);
	return (
		<div className="flex flex-col gap-3">
			<input
				ref={picker}
				type="file"
				accept=".csv,text/csv"
				className="hidden"
				onChange={async (e) => {
					const file = e.target.files?.[0];
					e.target.value = "";
					if (file) onRead(await file.text(), file.name);
				}}
			/>
			<Button
				variant="outline"
				size="lg"
				disabled={busy}
				onClick={() => picker.current?.click()}
			>
				{busy ? <Loader2 className="animate-spin" /> : <Upload />}
				Choose a CSV file
			</Button>
			<textarea
				value={pasted}
				onChange={(e) => onPaste(e.target.value)}
				placeholder="Or paste the CSV here"
				aria-invalid={problem !== null}
				className="h-40 rounded-lg border border-input bg-white p-2 font-mono text-xs outline-none focus:border-ring aria-invalid:border-critical-text"
			/>
			<div className="flex items-center gap-3">
				<Button
					disabled={busy || pasted.trim() === ""}
					onClick={() => onRead(pasted, null)}
				>
					Read pasted CSV
				</Button>
				{problem && (
					<span className="text-xs text-critical-text">{problem}</span>
				)}
			</div>
		</div>
	);
}
