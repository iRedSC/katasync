import { Pencil, Trash2 } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { signOut } from "#/auth/client";
import {
	type Access,
	accessData,
	type Device,
	patchAccess,
} from "#/components/access-data";
import { Badge, Card } from "#/components/page";
import { IconAction, Row } from "#/components/rows";
import { StaffCard } from "#/components/staff-card";
import { Button } from "#/components/ui/button";
import { formatDay } from "#/lib/format";
import { optimism } from "#/lib/optimism";
import { assignDevice, removeDevice, renameDevice } from "#/server/auth";

export const devicesData = accessData;

const tidy = (name: string) => name.trim().replace(/\s+/g, " ");

const withDevice = (id: string, change: (d: Device) => Device | null) =>
	patchAccess((a) => ({
		...a,
		devices: a.devices.flatMap((d) => {
			if (d.id !== id) return [d];
			const next = change(d);
			return next ? [next] : [];
		}),
	}));

// Each person signs in with a passkey per phone or computer. Owners manage
// every device and give unassigned ones, from before staff, to whoever
// uses them; anyone else sees their own.
export function DevicesCard({ devices: access }: { devices: Access }) {
	const [renaming, setRenaming] = useState<string | null>(null);
	const people = access.staff.filter((p) => p.status === "active");

	async function rename(d: Device, name: string) {
		setRenaming(null);
		await optimism.change({
			label: `${d.name}'s name`,
			patch: withDevice(d.id, (x) => ({ ...x, name: tidy(name) })),
			send: () => renameDevice({ data: { id: d.id, name } }),
		});
	}

	async function remove(d: Device) {
		const warning = d.current
			? `Remove ${d.name}? This device will be signed out.`
			: `Remove ${d.name}? It won't be able to sign in.`;
		if (!confirm(warning)) return;
		const r = await optimism.change({
			label: `Removing ${d.name}`,
			patch: withDevice(d.id, () => null),
			send: () => removeDevice({ data: { id: d.id } }),
		});
		if (!r) return;
		toast.success(`Removed ${d.name}`);
		if (d.current) window.location.assign("/login");
	}

	const assign = (d: Device, staffId: string) => {
		const person = people.find((p) => p.id === staffId);
		if (!person) return;
		return optimism.change({
			label: `Giving ${d.name} to ${person.name}`,
			patch: withDevice(d.id, (x) => ({
				...x,
				staffId,
				staffName: person.name,
			})),
			send: () => assignDevice({ data: { id: d.id, staffId } }),
		});
	};

	return (
		<>
			<StaffCard access={access} />
			<Card title="Devices" flush aside={<Me access={access} />}>
				{access.devices.length === 0 ? (
					<p className="px-4 pb-3 text-muted-foreground">None.</p>
				) : (
					<ul>
						{access.devices.map((d) =>
							renaming === d.id ? (
								<Row key={d.id}>
									<NameForm
										initial={d.name}
										onSave={(name) => rename(d, name)}
										onCancel={() => setRenaming(null)}
									/>
								</Row>
							) : (
								<Row
									key={d.id}
									actions={
										access.owner && (
											<>
												<IconAction
													icon={Pencil}
													label="Rename"
													onClick={() => setRenaming(d.id)}
												/>
												<IconAction
													icon={Trash2}
													label="Remove"
													onClick={() => remove(d)}
												/>
											</>
										)
									}
								>
									<div className="min-w-0 flex-1">
										<p className="flex items-center gap-2 font-medium">
											<span className="truncate">{d.name}</span>
											{d.current && <Badge tone="info">This device</Badge>}
										</p>
										<p className="text-xs text-muted-foreground">
											{d.lastUsedAt
												? `Signed in ${formatDay(d.lastUsedAt)}`
												: `Added ${formatDay(d.createdAt)}`}
										</p>
									</div>
									{d.staffName ? (
										<span className="shrink-0 text-muted-foreground animate-in fade-in">
											{d.staffName}
										</span>
									) : access.owner && people.length > 0 ? (
										<select
											value=""
											onChange={(e) => assign(d, e.target.value)}
											aria-label={`Whose is ${d.name}`}
											className="h-8 shrink-0 rounded-lg border border-warning-text/40 bg-warning-fill px-2 text-warning-text"
										>
											<option value="" disabled>
												Unassigned
											</option>
											{people.map((p) => (
												<option key={p.id} value={p.id}>
													{p.name}
												</option>
											))}
										</select>
									) : (
										<Badge tone="warning">Unassigned</Badge>
									)}
								</Row>
							),
						)}
					</ul>
				)}
				<div className="border-t px-4 py-3">
					<Button
						size="sm"
						variant="outline"
						onClick={async () => {
							await signOut();
							window.location.assign("/login");
						}}
					>
						Sign out of this device
					</Button>
				</div>
			</Card>
		</>
	);
}

function Me({ access }: { access: Access }) {
	const { me } = access;
	switch (me.kind) {
		case "staff":
			return (
				<span>
					{me.name} · {me.role === "owner" ? "Owner" : "Operator"}
				</span>
			);
		case "unassigned":
			return <span>Unassigned device</span>;
		case "system":
			return <span>Dev server</span>;
	}
}

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
