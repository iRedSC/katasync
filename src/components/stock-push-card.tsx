import { useRouter } from "@tanstack/react-router";
import { Loader2 } from "lucide-react";
import { useRef, useState } from "react";
import { toast } from "sonner";
import { Badge, Card } from "#/components/page";
import { Row } from "#/components/rows";
import { Button } from "#/components/ui/button";
import { Tip } from "#/components/ui/tooltip";
import { channelName } from "#/lib/format";
import { type listStockPush, setStockPush } from "#/server/stock-push";
import { stockPushStatus } from "#/stock-push/status";

type StockPush = Awaited<ReturnType<typeof listStockPush>>;
type Store = StockPush["stores"][number];

export function StockPushCard({ data }: { data: StockPush }) {
	return (
		<Card title="Stock push" flush>
			<ul>
				{data.stores.map((store) => (
					<StoreRow key={store.id} store={store} data={data} />
				))}
			</ul>
		</Card>
	);
}

function StoreRow({ store, data }: { store: Store; data: StockPush }) {
	const router = useRouter();
	const pending = useRef(false);
	const [saving, setSaving] = useState(false);
	const status = stockPushStatus(store, data);
	async function turnOff() {
		if (pending.current) return;
		pending.current = true;
		setSaving(true);
		try {
			await setStockPush({ data: { id: store.id, on: false } });
			await router.invalidate();
			toast.success("Stock push turned off");
		} catch (error) {
			toast.error(error instanceof Error ? error.message : String(error));
		} finally {
			pending.current = false;
			setSaving(false);
		}
	}
	const action = store.on ? (
		<Button size="sm" variant="ghost" disabled={saving} onClick={turnOff}>
			{saving && <Loader2 className="animate-spin" />}Turn off
		</Button>
	) : (
		<Tip content={data.blocker}>
			<Button size="sm" variant="ghost" disabled>
				Unavailable
			</Button>
		</Tip>
	);
	return (
		<Row actions={action}>
			<span className="w-20 shrink-0 font-medium">
				{channelName(store.channel)}
			</span>
			<div className="flex min-w-0 flex-col gap-0.5">
				<span className="flex items-center gap-2">
					<Badge tone={status.kind === "blocked" ? "critical" : undefined}>
						{status.kind === "blocked" ? "Blocked" : "Off"}
					</Badge>
					<span className="truncate text-muted-foreground">{store.name}</span>
				</span>
				{status.kind === "blocked" && (
					<span className="text-xs text-critical-text">{status.why}</span>
				)}
			</div>
		</Row>
	);
}
