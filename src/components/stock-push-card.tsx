import { Link, useRouter } from "@tanstack/react-router";
import { useState } from "react";
import { toast } from "sonner";
import { Badge, Card } from "#/components/page";
import { Row } from "#/components/rows";
import { Button } from "#/components/ui/button";
import { Tip } from "#/components/ui/tooltip";
import { channelName, formatDateTime } from "#/lib/format";
import { type listStockPush, setStockPush } from "#/server/stock-push";
import { type StockPushStatus, stockPushStatus } from "#/stock-push/status";

type StockPush = Awaited<ReturnType<typeof listStockPush>>;
type Store = StockPush["stores"][number];

const plural = (n: number, one: string, many = `${one}s`) =>
	`${n.toLocaleString()} ${n === 1 ? one : many}`;

// Which stores katasync sets listing quantities for. A store moves over from
// Sumtracker one at a time: Sumtracker's sync off for it first, then on here,
// so the two never overwrite each other.
export function StockPushCard({ data }: { data: StockPush }) {
	return (
		<Card title="Stock push" flush>
			<ul>
				{data.stores.map((s) => (
					<StoreRow key={s.id} store={s} data={data} />
				))}
			</ul>
		</Card>
	);
}

function StoreRow({ store, data }: { store: Store; data: StockPush }) {
	const router = useRouter();
	const [saving, setSaving] = useState(false);
	const status = stockPushStatus(store, data);

	async function set(on: boolean) {
		if (
			on &&
			!confirm(
				`Turn off Sumtracker's stock sync for ${store.name} first, or the two will keep overwriting each other.\n\nkatasync then sets ${plural(store.mapped, "mapped listing")} to its own counts within a few minutes. Turn on?`,
			)
		)
			return;
		setSaving(true);
		try {
			await setStockPush({ data: { id: store.id, on } });
			toast.success(
				on
					? `${store.name}'s stock is set by katasync from its next sync`
					: `katasync stopped setting ${store.name}'s stock`,
			);
			await router.invalidate();
		} catch (err) {
			toast.error(err instanceof Error ? err.message : String(err));
		} finally {
			setSaving(false);
		}
	}

	const action = store.on ? (
		<Button
			size="sm"
			variant="ghost"
			disabled={saving}
			onClick={() => set(false)}
		>
			Turn off
		</Button>
	) : data.blocker ? (
		<Tip content={data.blocker}>
			{/* A disabled button gets no hover, so the tip sits on a wrapper. */}
			<span>
				<Button size="sm" variant="ghost" disabled>
					Turn on
				</Button>
			</span>
		</Tip>
	) : (
		<Button
			size="sm"
			variant="ghost"
			disabled={saving}
			onClick={() => set(true)}
		>
			Turn on
		</Button>
	);

	return (
		<Row actions={action}>
			<span className="w-20 shrink-0 font-medium">
				{channelName(store.channel)}
			</span>
			<div className="flex min-w-0 flex-col gap-0.5">
				<span className="flex items-center gap-2">
					<StatusBadge status={status} />
					<span className="truncate text-muted-foreground">{store.name}</span>
				</span>
				<StatusDetail status={status} />
			</div>
		</Row>
	);
}

function StatusBadge({ status }: { status: StockPushStatus }) {
	switch (status.kind) {
		case "off":
			return <Badge>Off</Badge>;
		case "blocked":
		case "stopped":
			return <Badge tone="critical">Stopped</Badge>;
		case "preview":
			return <Badge tone="info">Preview only</Badge>;
		case "starting":
			return <Badge tone="info">Starting</Badge>;
		case "pushing":
			return status.failing > 0 ? (
				<Badge tone="warning">On, with problems</Badge>
			) : (
				<Badge tone="success">On</Badge>
			);
	}
}

function StatusDetail({ status }: { status: StockPushStatus }) {
	const text = "text-xs text-muted-foreground";
	switch (status.kind) {
		case "off":
			return null;
		case "blocked":
		case "stopped":
			return <span className="text-xs text-critical-text">{status.why}</span>;
		case "preview":
			return (
				<span className={text}>
					This isn't production, so it only works out what it would set.
					Diagnostics lists the changes.
				</span>
			);
		case "starting":
			return (
				<span className={text}>Its first push runs with the next sync.</span>
			);
		case "pushing": {
			const unset = status.mapped - status.ready;
			return (
				<span className={text}>
					Checked {formatDateTime(status.pushedAt)}.{" "}
					{plural(status.ready, "listing")} set
					{unset > 0 && <>, {plural(unset, "listing")} it can't set</>}
					{status.failing > 0 && (
						<>, {plural(status.failing, "refused", "refused")}</>
					)}
					{(unset > 0 || status.failing > 0) && (
						<>
							{" "}
							(
							<Link to="/diagnostics" className="underline">
								see Diagnostics
							</Link>
							)
						</>
					)}
					.
				</span>
			);
		}
	}
}
