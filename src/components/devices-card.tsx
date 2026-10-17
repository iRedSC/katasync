import { useRouter } from "@tanstack/react-router";
import QRCode from "qrcode";
import { useState } from "react";
import { toast } from "sonner";
import { signOut } from "#/auth/client";
import { Badge, Card } from "#/components/page";
import { Button } from "#/components/ui/button";
import { formatDay } from "#/lib/format";
import { optimism, optimistic } from "#/lib/optimism";
import {
	createDeviceLink,
	type listDevices,
	removeDevice,
	renameDevice,
} from "#/server/auth";

type Device = Awaited<ReturnType<typeof listDevices>>[number];

// Renames and removals show at once, from this list.
export const devicesData = optimistic<Device[]>("devices");

const message = (err: unknown) =>
	err instanceof Error ? err.message : String(err);

// The name as the server keeps it (see passkeyName).
const tidy = (name: string) => name.trim().replace(/\s+/g, " ");

// Everyone shares one company account; each phone or computer signs in with
// its own passkey. Adding one makes a link to open on the new device.
export function DevicesCard({ devices }: { devices: Device[] }) {
	const router = useRouter();
	const [link, setLink] = useState<{
		url: string;
		qr: string;
		expiresAt: Date;
	} | null>(null);
	const [renaming, setRenaming] = useState<string | null>(null);

	async function addDevice() {
		try {
			const made = await createDeviceLink();
			setLink({
				...made,
				expiresAt: new Date(made.expiresAt),
				qr: await QRCode.toDataURL(made.url, { margin: 1, width: 192 }),
			});
		} catch (err) {
			toast.error(message(err));
		}
	}

	async function rename(d: Device, name: string) {
		setRenaming(null);
		await optimism.change({
			label: `${d.name}'s name`,
			patch: devicesData.patch("all", (list) =>
				list.map((x) => (x.id === d.id ? { ...x, name: tidy(name) } : x)),
			),
			send: () => renameDevice({ data: { id: d.id, name } }),
		});
	}

	async function remove(d: Device) {
		const warning = d.current
			? `Remove ${d.name}? This device will be signed out.`
			: devices.length === 1
				? `Remove ${d.name}? It's the last device; getting back in will need pnpm auth:setup-link on the server.`
				: `Remove ${d.name}? It won't be able to sign in.`;
		if (!confirm(warning)) return;
		const r = await optimism.change({
			label: `Removing ${d.name}`,
			patch: devicesData.patch("all", (list) =>
				list.filter((x) => x.id !== d.id),
			),
			send: () => removeDevice({ data: { id: d.id } }),
		});
		if (!r) return;
		toast.success(`Removed ${d.name}`);
		if (d.current) window.location.assign("/login");
	}

	return (
		<Card
			title="Devices"
			flush
			aside={
				!link && (
					<Button size="sm" variant="outline" onClick={addDevice}>
						Add a device
					</Button>
				)
			}
		>
			{link && (
				<div className="flex gap-4 border-t px-4 py-3">
					<img src={link.qr} alt="Setup link" className="size-36 shrink-0" />
					<div className="flex min-w-0 flex-col gap-2">
						<p>
							Open on the new device. Works once, until{" "}
							{link.expiresAt.toLocaleTimeString([], {
								hour: "numeric",
								minute: "2-digit",
							})}
							.
						</p>
						<code className="truncate rounded bg-surface px-2 py-1 text-xs">
							{link.url}
						</code>
						<div className="flex gap-2">
							<Button
								size="sm"
								variant="outline"
								onClick={() =>
									navigator.clipboard
										.writeText(link.url)
										.then(() => toast.success("Copied"))
								}
							>
								Copy link
							</Button>
							<Button
								size="sm"
								variant="ghost"
								onClick={() => {
									setLink(null);
									router.invalidate();
								}}
							>
								Done
							</Button>
						</div>
					</div>
				</div>
			)}
			{devices.length === 0 ? (
				<p className="border-t px-4 py-3 text-muted-foreground">
					None. Or run pnpm auth:setup-link on the server.
				</p>
			) : (
				<ul>
					{devices.map((d) => (
						<li
							key={d.id}
							className="flex items-center gap-3 border-t px-4 py-3"
						>
							{renaming === d.id ? (
								<NameForm
									initial={d.name}
									onSave={(name) => rename(d, name)}
									onCancel={() => setRenaming(null)}
								/>
							) : (
								<>
									<span className="flex flex-1 items-center gap-2 font-medium">
										{d.name}
										{d.current && <Badge tone="info">This device</Badge>}
									</span>
									<span className="text-muted-foreground">
										{d.lastUsedAt
											? `Last signed in ${formatDay(d.lastUsedAt)}`
											: `Added ${formatDay(d.createdAt)}`}
									</span>
									<Button
										size="sm"
										variant="ghost"
										onClick={() => setRenaming(d.id)}
									>
										Rename
									</Button>
									<Button size="sm" variant="ghost" onClick={() => remove(d)}>
										Remove
									</Button>
								</>
							)}
						</li>
					))}
				</ul>
			)}
			<div className="border-t px-4 py-3">
				<Button
					size="sm"
					variant="ghost"
					onClick={async () => {
						await signOut();
						window.location.assign("/login");
					}}
				>
					Sign out of this device
				</Button>
			</div>
		</Card>
	);
}

// Opened with the device's current name. Save needs a name in it.
function NameForm({
	initial,
	onSave,
	onCancel,
}: {
	initial: string;
	onSave: (name: string) => void;
	onCancel: () => void;
}) {
	const [name, setName] = useState(initial);
	return (
		<form
			className="flex flex-1 gap-2"
			onSubmit={(e) => {
				e.preventDefault();
				onSave(name);
			}}
			onKeyDown={(e) => e.key === "Escape" && onCancel()}
		>
			<input
				value={name}
				// biome-ignore lint/a11y/noAutofocus: opened to rename
				autoFocus
				onChange={(e) => setName(e.target.value)}
				className="h-8 flex-1 rounded-lg border border-input bg-white px-2 outline-none focus:border-ring"
			/>
			<Button type="submit" size="sm" disabled={name.trim() === ""}>
				Save
			</Button>
		</form>
	);
}
