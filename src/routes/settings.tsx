import { createFileRoute, useRouter } from "@tanstack/react-router";
import { type FormEvent, type ReactNode, useState } from "react";
import { toast } from "sonner";
import { Badge, Card, Page } from "#/components/page";
import { Button } from "#/components/ui/button";
import { listLocations, listStores } from "#/server/catalog";
import { deletePackage, listPackages, savePackage } from "#/server/shipping";

export const Route = createFileRoute("/settings")({
	loader: async () => {
		const [locations, stores, boxes] = await Promise.all([
			listLocations(),
			listStores(),
			listPackages(),
		]);
		return { locations, stores, boxes };
	},
	component: Settings,
});

const channels = [
	{ id: "shopify", name: "Shopify" },
	{ id: "amazon", name: "Amazon" },
	{ id: "ebay", name: "eBay" },
	{ id: "tiktok", name: "TikTok Shop" },
] as const;

function Settings() {
	const { locations, stores, boxes } = Route.useLoaderData();
	return (
		<Page title="Settings" narrow>
			<Card title="Sales channels" flush>
				<ul>
					{channels.map((c) => {
						const connected = stores.filter((s) => s.channel === c.id);
						return (
							<Item key={c.id} label={c.name}>
								{connected.length > 0 ? (
									<Badge tone="success">
										{connected.map((s) => s.name).join(", ")}
									</Badge>
								) : (
									<Badge>Not connected</Badge>
								)}
							</Item>
						);
					})}
				</ul>
			</Card>
			<Card title="Locations" flush>
				<ul>
					{locations.map((l) => (
						<Item key={l.id} label={l.name}>
							<span className="text-muted-foreground">
								{l.kind === "fba" ? "Amazon's warehouse" : "Ours"}
							</span>
						</Item>
					))}
				</ul>
			</Card>
			<Boxes boxes={boxes} />
			<Card title="Label printing">
				<p className="text-muted-foreground">
					Not set up yet. Each packing computer needs QZ Tray.
				</p>
			</Card>
		</Page>
	);
}

function Item({ label, children }: { label: string; children: ReactNode }) {
	return (
		<li className="flex items-center justify-between border-t px-4 py-3 first:border-t-0">
			<span className="font-medium">{label}</span>
			{children}
		</li>
	);
}

type Box = Awaited<ReturnType<typeof listPackages>>[number];
const inches = (mm: number) => Math.round((mm / 25.4) * 10) / 10;

// The boxes quick ship knows by pin. Typing a box's pin fills in its size
// and empty weight.
function Boxes({ boxes }: { boxes: Box[] }) {
	const router = useRouter();
	const [adding, setAdding] = useState(false);

	async function add(e: FormEvent<HTMLFormElement>) {
		e.preventDefault();
		const f = new FormData(e.currentTarget);
		const n = (key: string) => Number(f.get(key));
		try {
			const saved = await savePackage({
				data: {
					name: String(f.get("name")),
					lengthIn: n("length"),
					widthIn: n("width"),
					heightIn: n("height"),
					weightOz: n("weight") || 0,
					...(f.get("pin") ? { pin: n("pin") } : {}),
				},
			});
			toast.success(`Saved ${saved.name} as pin ${saved.pin}`);
			setAdding(false);
			router.invalidate();
		} catch (err) {
			toast.error(err instanceof Error ? err.message : String(err));
		}
	}

	async function remove(box: Box) {
		await deletePackage({ data: { id: box.id } });
		router.invalidate();
		toast.success(`Removed ${box.name}`);
	}

	const field =
		"h-9 rounded-lg border border-input px-2 tabular-nums outline-none focus:border-ring";
	return (
		<Card
			title="Boxes"
			flush
			aside={
				!adding && (
					<Button size="sm" variant="outline" onClick={() => setAdding(true)}>
						Add box
					</Button>
				)
			}
		>
			{boxes.length === 0 && !adding && (
				<p className="px-4 py-3 text-muted-foreground">
					No boxes yet. Each box gets a 3-digit pin to type in quick ship
					(Ctrl+Space).
				</p>
			)}
			<ul>
				{boxes.map((b) => (
					<li
						key={b.id}
						className="flex items-center gap-3 border-t px-4 py-3 first:border-t-0"
					>
						<span className="w-12 font-mono text-base font-bold">{b.pin}</span>
						<span className="flex-1 font-medium">{b.name}</span>
						<span className="text-muted-foreground tabular-nums">
							{inches(b.lengthMm)} × {inches(b.widthMm)} × {inches(b.heightMm)}{" "}
							in
						</span>
						<Button size="sm" variant="ghost" onClick={() => remove(b)}>
							Remove
						</Button>
					</li>
				))}
			</ul>
			{adding && (
				<form
					onSubmit={add}
					className="flex flex-wrap items-end gap-2 border-t px-4 py-3"
				>
					<label className="flex flex-1 flex-col gap-1">
						<span className="text-muted-foreground">Name</span>
						{/* biome-ignore lint/a11y/noAutofocus: opened to type this */}
						<input name="name" required autoFocus className={field} />
					</label>
					{(["length", "width", "height"] as const).map((d) => (
						<label key={d} className="flex w-16 flex-col gap-1">
							<span className="text-muted-foreground capitalize">{d}</span>
							<input
								name={d}
								required
								inputMode="decimal"
								placeholder="in"
								className={field}
							/>
						</label>
					))}
					<label className="flex w-20 flex-col gap-1">
						<span className="text-muted-foreground">Empty wt</span>
						<input
							name="weight"
							inputMode="decimal"
							placeholder="oz"
							className={field}
						/>
					</label>
					<label className="flex w-16 flex-col gap-1">
						<span className="text-muted-foreground">Pin</span>
						<input
							name="pin"
							inputMode="numeric"
							maxLength={3}
							placeholder="auto"
							className={field}
						/>
					</label>
					<Button type="submit" size="sm">
						Save
					</Button>
					<Button
						type="button"
						size="sm"
						variant="ghost"
						onClick={() => setAdding(false)}
					>
						Cancel
					</Button>
				</form>
			)}
		</Card>
	);
}
