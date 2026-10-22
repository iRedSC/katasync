import { SprayCan } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Truncate } from "#/components/truncate";
import { optimism } from "#/lib/optimism";
import { cn } from "#/lib/utils";
import { savePackage } from "#/server/shipping";
import {
	boxSize,
	filterBoxes,
	inches,
	sameSize,
	typedSize,
} from "#/shipping/box-filter";
import {
	type BoxEntry,
	emptyEntry,
	entryQuery,
	isPartial,
	sizeEntry,
} from "./box-entry";
import { BoxEntryInput } from "./box-entry-input";
import { Key } from "./key";
import type { Box, Dims } from "./types";
import { ounces } from "./units";

// What Enter can pick: a saved box, or the typed size, once or saved.
type Option =
	| { kind: "box"; box: Box }
	| { kind: "custom"; dims: Dims }
	| { kind: "save"; dims: Dims };

const keyOf = (o: Option) => (o.kind === "box" ? `box:${o.box.id}` : o.kind);

const sidesOf = (d: Dims) => [d.lengthMm, d.widthMm, d.heightMm].map(inches);

// Rows shown before the list scrolls.
const ROWS = 6;

// Type the size off the box's label ("12 9 4") or a bit of its name; the
// list narrows as you type. Enter on a partial entry fills in the highlighted
// box's size; Enter on a whole one (or nothing) takes the row. A size no
// saved box has can ship once or be saved as a box.
export function PackageStep({
	boxes,
	current,
	dims,
	hazmat,
	onHazmat,
	onChoose,
	onSaved,
}: {
	boxes: Box[];
	current: Box | null;
	dims: Dims | null;
	hazmat: boolean;
	onHazmat: () => void;
	onChoose: (choice: { box: Box | null; dims: Dims }) => void;
	onSaved: (box: Box) => void;
}) {
	// A size used last time without a saved box starts typed in.
	const [entry, setEntry] = useState<BoxEntry>(
		!current && dims ? sizeEntry(sidesOf(dims)) : emptyEntry,
	);
	const query = entryQuery(entry);
	const [saving, setSaving] = useState(false);

	// A complete size picks the box of exactly that size first, or the size
	// typed (once or saved) when none is saved. Prefix matches come after, as
	// alternatives, so 12 12 1 never picks a 12 12 12 box by default.
	const size = typedSize(query);
	const fits = filterBoxes(boxes, query);
	const exact = size ? fits.filter((b) => sameSize(b, size)) : [];
	const options: Option[] = [
		...exact.map((box) => ({ kind: "box" as const, box })),
		...(size && exact.length === 0
			? [
					{ kind: "custom" as const, dims: size },
					{ kind: "save" as const, dims: size },
				]
			: []),
		...fits
			.filter((b) => !exact.includes(b))
			.map((box) => ({ kind: "box" as const, box })),
	];
	// The box from last time stays highlighted until something else is typed
	// or picked.
	const [picked, setPicked] = useState<string | null>(
		current ? `box:${current.id}` : null,
	);
	const index = Math.max(
		0,
		options.findIndex((o) => keyOf(o) === picked),
	);
	const highlighted = options[index] as Option | undefined;

	const list = useRef<HTMLDivElement>(null);
	useEffect(() => {
		list.current?.children[index]?.scrollIntoView({ block: "nearest" });
	}, [index]);

	async function choose(option: Option) {
		if (saving) return;
		if (option.kind === "box")
			return onChoose({ box: option.box, dims: option.box });
		if (option.kind === "custom")
			return onChoose({ box: null, dims: option.dims });
		// The new box needs its id, so it waits for the reload that shows it.
		// No empty weight; add one in Settings if it matters.
		setSaving(true);
		const r = await optimism.change({
			send: () =>
				savePackage({
					data: {
						name: null,
						lengthIn: option.dims.lengthMm / 25.4,
						widthIn: option.dims.widthMm / 25.4,
						heightIn: option.dims.heightMm / 25.4,
						weightOz: 0,
					},
				}),
		});
		setSaving(false);
		if (!r) return;
		onSaved(r.value);
		onChoose({ box: r.value, dims: r.value });
	}

	// Enter on a half-typed size or a name fills in the highlighted box's
	// size, keeping it highlighted; the next Enter takes it.
	function enter(option: Option) {
		if (option.kind === "box" && isPartial(entry)) {
			setEntry(sizeEntry(sidesOf(option.box)));
			return setPicked(keyOf(option));
		}
		choose(option);
	}

	function move(by: number) {
		if (options.length === 0) return;
		const next = (index + by + options.length) % options.length;
		setPicked(keyOf(options[next]));
	}

	return (
		<div className="flex flex-col gap-3">
			<div className="flex items-baseline justify-between">
				<p className="text-xl font-semibold">Box</p>
				<p className="text-muted-foreground">
					Size (<Key>Space</Key> between sides) or name · <Key>↑</Key>
					<Key>↓</Key> picks
				</p>
			</div>
			<button
				type="button"
				role="switch"
				aria-checked={hazmat}
				tabIndex={-1}
				// Clicking keeps the focus in the input.
				onMouseDown={(e) => e.preventDefault()}
				onClick={onHazmat}
				className={cn(
					"flex h-10 items-center justify-between gap-3 rounded-xl border-2 px-4 text-lg",
					hazmat
						? "border-warning-border bg-warning-surface font-semibold text-warning-text"
						: "border-border text-muted-foreground hover:bg-subtle",
				)}
			>
				<span className="flex items-center gap-2">
					<SprayCan className="size-5" />
					{hazmat
						? "Aerosols: ground only, Limited Quantity mark prints"
						: "No aerosols"}
				</span>
				<span>
					<Key>Ctrl</Key> <Key>H</Key>
				</span>
			</button>
			<BoxEntryInput
				entry={entry}
				disabled={saving}
				onEntry={(next) => {
					setEntry(next);
					setPicked(null);
				}}
				onKeyDown={(e) => {
					if (e.key === "ArrowDown" || e.key === "ArrowUp") {
						e.preventDefault();
						move(e.key === "ArrowDown" ? 1 : -1);
					}
					if (e.key === "Enter" && highlighted) enter(highlighted);
				}}
			/>
			{saving ? (
				<p className="flex h-8 items-center justify-center text-lg text-muted-foreground">
					Saving box…
				</p>
			) : options.length === 0 ? (
				<p className="flex h-8 items-center justify-center text-lg text-muted-foreground">
					{boxes.length === 0
						? "No saved boxes. Type length, width, and height."
						: "No box fits that. Type all three sides for a custom size."}
				</p>
			) : (
				<div
					ref={list}
					className="flex flex-col gap-2 overflow-y-auto"
					// Short screens get fewer rows, so the dialog's top stays on screen.
					style={{ maxHeight: `min(${ROWS * 3.5}rem, 28dvh)` }}
				>
					{options.map((o, i) => (
						<button
							type="button"
							key={keyOf(o)}
							tabIndex={-1}
							aria-pressed={i === index}
							// Clicking keeps the focus in the input.
							onMouseDown={(e) => e.preventDefault()}
							onMouseMove={() => setPicked(keyOf(o))}
							onClick={() => choose(o)}
							className={cn(
								"flex h-12 shrink-0 items-center justify-between gap-3 rounded-xl border-2 px-4 text-lg",
								i === index
									? "border-primary bg-primary text-primary-foreground"
									: "border-border hover:bg-subtle",
							)}
						>
							<OptionLabel
								option={o}
								lastTime={o.kind === "box" && o.box.id === current?.id}
							/>
						</button>
					))}
				</div>
			)}
		</div>
	);
}

function OptionLabel({
	option,
	lastTime,
}: {
	option: Option;
	lastTime: boolean;
}) {
	if (option.kind !== "box")
		return (
			<>
				<span className="font-semibold tabular-nums">
					{boxSize(option.dims)} in
				</span>
				<span className="opacity-70">
					{option.kind === "custom" ? "This once" : "Save as a box"}
				</span>
			</>
		);
	const { box } = option;
	const detail = [
		lastTime && "last time",
		box.weightGrams > 0 && `${ounces(box.weightGrams)} oz empty`,
	]
		.filter(Boolean)
		.join(" · ");
	return (
		<>
			<Truncate
				text={`${boxSize(box)} in${box.name ? ` ${box.name}` : ""}`}
				className="tabular-nums"
			>
				<span className="font-semibold">{boxSize(box)} in</span>
				{box.name && <span className="ml-2">{box.name}</span>}
			</Truncate>
			{detail && <span className="shrink-0 opacity-70">{detail}</span>}
		</>
	);
}
