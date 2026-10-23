import { Loader2 } from "lucide-react";
import { useState } from "react";
import { formatCents } from "#/banking/money";
import { Badge } from "#/components/page";
import { PanelHeader, SidePanel } from "#/components/panel";
import { Button } from "#/components/ui/button";
import { formatDate, formatDateTime } from "#/lib/format";
import { optimism } from "#/lib/optimism";
import { offerUndo } from "#/lib/undo";
import { matchBankRow, undoBankMatch } from "#/server/banking";
import { AllocateForm, type PartInput } from "./allocate-form";
import { MARKET_STATUS, ROW_STATE, type Row } from "./states";

async function sendMatch(
	transactionId: number,
	parts: PartInput[],
	replaces: number | null,
) {
	const r = await optimism.change({
		send: () => matchBankRow({ data: { transactionId, parts, replaces } }),
	});
	if (!r) return { kind: "failed" as const };
	return r.value.ok
		? { kind: "matched" as const, matchId: r.value.value.matchId }
		: { kind: "refused" as const, problem: r.value.problem };
}

function offerUndoMatch(
	matchId: number,
	transactionId: number,
	parts: PartInput[],
	message: string,
) {
	offerUndo(message, {
		tone: "success",
		undo: async () => {
			const r = await optimism.change({
				send: () => undoBankMatch({ data: { matchId } }),
			});
			if (!r) return null;
			if (!r.value.ok) throw new Error(r.value.problem);
			offerRedo(transactionId, parts);
			return null;
		},
	});
}

function offerRedo(transactionId: number, parts: PartInput[]) {
	offerUndo("Match undone", {
		undo: async () => {
			const r = await sendMatch(transactionId, parts, null);
			if (r.kind === "refused") throw new Error(r.problem);
			return r.kind === "matched" ? "Matched again" : null;
		},
	});
}

export function MatchPanel({
	row,
	currency,
	onClose,
}: {
	row: Row | null;
	currency: string;
	onClose: () => void;
}) {
	return (
		<SidePanel open={row !== null} onClose={onClose}>
			{row && (
				<PanelBody
					key={row.id}
					row={row}
					currency={currency}
					onClose={onClose}
				/>
			)}
		</SidePanel>
	);
}

function PanelBody({
	row,
	currency,
	onClose,
}: {
	row: Row;
	currency: string;
	onClose: () => void;
}) {
	const [busy, setBusy] = useState<"undo" | "again" | null>(null);
	const [problem, setProblem] = useState<string | null>(null);
	const money = (c: number) => formatCents(c, currency);
	const state = row.state;

	async function confirm(parts: PartInput[]) {
		const r = await sendMatch(row.id, parts, null);
		if (r.kind === "refused") return r.problem;
		if (r.kind === "matched") {
			onClose();
			offerUndoMatch(
				r.matchId,
				row.id,
				parts,
				`Matched ${money(row.amountCents)}`,
			);
		}
		return null;
	}

	async function undo() {
		if (state.kind === "unmatched" || busy) return;
		setBusy("undo");
		const parts = state.match.parts.map(({ target, amountCents }) => ({
			target,
			amountCents,
		}));
		const r = await optimism.change({
			send: () => undoBankMatch({ data: { matchId: state.match.id } }),
		});
		setBusy(null);
		if (!r) return;
		if (!r.value.ok) return setProblem(r.value.problem);
		onClose();
		offerRedo(row.id, parts);
	}

	async function again() {
		if (state.kind !== "needs-review" || busy) return;
		setBusy("again");
		const parts = state.match.parts.map(({ target, amountCents }) => ({
			target,
			amountCents,
		}));
		const r = await sendMatch(row.id, parts, state.match.id);
		setBusy(null);
		if (r.kind === "refused") return setProblem(r.problem);
		if (r.kind === "matched") onClose();
	}

	return (
		<>
			<PanelHeader
				title={money(row.amountCents)}
				status={ROW_STATE[state.kind]}
			/>
			<div className="flex flex-col gap-1">
				<p className="font-medium">{row.description || "No description"}</p>
				<p className="text-xs text-muted-foreground">
					{formatDate(row.postedOn)} · import #{row.importId}, row{" "}
					{row.rowNumber}
					{row.bankRef && ` · ${row.bankRef}`}
				</p>
				{row.possibleRepeat && (
					<span>
						<Badge tone="warning">Same row in another import</Badge>
					</span>
				)}
				{row.pastMatches > 0 && (
					<p className="text-xs text-muted-foreground">
						Undone {row.pastMatches}× before
					</p>
				)}
			</div>
			{state.kind === "unmatched" ? (
				<AllocateForm transactionId={row.id} onConfirm={confirm} />
			) : (
				<div className="flex flex-col gap-4">
					{state.kind === "needs-review" && (
						<ul className="flex flex-col gap-1 rounded-lg bg-warning-surface px-3 py-2 text-warning-text">
							{state.reasons.map((r) => (
								<li key={r}>{r}</li>
							))}
						</ul>
					)}
					<ul className="flex flex-col divide-y rounded-lg border">
						{state.match.parts.map((p) => (
							<li
								key={`${p.target.kind}:${p.target.id}`}
								className="flex flex-col gap-0.5 px-3 py-2"
							>
								<div className="flex items-center gap-2">
									<span className="flex-1 truncate font-medium">{p.label}</span>
									<span className="tabular-nums">{money(p.amountCents)}</span>
								</div>
								<div className="flex items-center gap-2 text-xs text-muted-foreground">
									<span>Marketplace says</span>
									{p.current ? (
										<>
											<Badge tone={MARKET_STATUS[p.current.status]?.tone}>
												{MARKET_STATUS[p.current.status]?.label ??
													p.current.status}
											</Badge>
											<span className="tabular-nums">
												{formatCents(p.current.amountCents, p.current.currency)}
											</span>
										</>
									) : (
										<Badge tone="critical">Gone</Badge>
									)}
									<span className="ml-auto">
										was{" "}
										{formatCents(p.observed.amountCents, p.observed.currency)},{" "}
										{p.observed.status}
									</span>
								</div>
							</li>
						))}
					</ul>
					<p className="text-xs text-muted-foreground">
						Matched {formatDateTime(state.match.matchedAt)}
					</p>
					<div className="flex items-center gap-2">
						<Button variant="outline" onClick={undo} disabled={busy !== null}>
							{busy === "undo" && <Loader2 className="animate-spin" />}
							Undo match
						</Button>
						{state.kind === "needs-review" && (
							<Button onClick={again} disabled={busy !== null}>
								{busy === "again" && <Loader2 className="animate-spin" />}
								Confirm as it is now
							</Button>
						)}
					</div>
					{problem && <p className="text-xs text-critical-text">{problem}</p>}
				</div>
			)}
		</>
	);
}
