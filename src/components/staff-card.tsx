import { useRouter } from "@tanstack/react-router";
import { Link2, RotateCcw, Shield, ShieldCheck, Trash2 } from "lucide-react";
import { type FormEvent, useState } from "react";
import { toast } from "sonner";
import {
	type Access,
	errorMessage,
	type Person,
	patchAccess,
} from "#/components/access-data";
import { Badge, Card } from "#/components/page";
import { ActionSlot, IconAction, Row } from "#/components/rows";
import {
	type MadeLink,
	madeLink,
	SetupLinkPanel,
} from "#/components/setup-link-panel";
import { Button } from "#/components/ui/button";
import { optimism } from "#/lib/optimism";
import { cn } from "#/lib/utils";
import {
	addStaffMember,
	becomeOwner,
	createDeviceLink,
	removeStaffMember,
	restoreStaffMember,
	setStaffRole,
} from "#/server/staff";

type Role = Person["role"];

const withPerson = (id: string, change: Partial<Person>) =>
	patchAccess((a) => ({
		...a,
		staff: a.staff.map((p) => (p.id === id ? { ...p, ...change } : p)),
	}));

const inputClass =
	"h-8 min-w-0 flex-1 rounded-lg border border-input bg-white px-2 outline-none focus:border-ring";

export function StaffCard({ access }: { access: Access }) {
	if (access.needsOwner) return <ClaimOwner />;
	if (!access.owner) return null;
	return <StaffList access={access} />;
}

function ClaimOwner() {
	const router = useRouter();
	const [name, setName] = useState("");
	const [busy, setBusy] = useState(false);

	async function submit(e: FormEvent) {
		e.preventDefault();
		setBusy(true);
		try {
			await becomeOwner({ data: { name } });
			await router.invalidate();
		} catch (err) {
			toast.error(errorMessage(err));
		} finally {
			setBusy(false);
		}
	}

	return (
		<Card title="Staff" tone="warning" aside="No owner yet">
			<form onSubmit={submit} className="flex gap-2">
				<input
					value={name}
					onChange={(e) => setName(e.target.value)}
					placeholder="Your name"
					aria-label="Your name"
					className={inputClass}
				/>
				<Button type="submit" size="sm" disabled={busy || name.trim() === ""}>
					{busy ? "Saving…" : "I'm the owner"}
				</Button>
			</form>
		</Card>
	);
}

function StaffList({ access }: { access: Access }) {
	const router = useRouter();
	const [link, setLink] = useState<MadeLink | null>(null);
	const meId = access.me.kind === "staff" ? access.me.staffId : null;
	const owners = access.staff.filter(
		(p) => p.role === "owner" && p.status === "active",
	).length;

	async function linkFor(person: { id: string; name: string }) {
		try {
			const made = await createDeviceLink({ data: { staffId: person.id } });
			setLink(await madeLink(person.name, made));
		} catch (err) {
			toast.error(errorMessage(err));
		}
	}

	const setRole = (p: Person, role: Role) =>
		optimism.change({
			label: `${p.name}'s role`,
			patch: withPerson(p.id, { role }),
			send: () => setStaffRole({ data: { staffId: p.id, role } }),
		});

	async function remove(p: Person) {
		if (p.id === meId && !confirm("Remove yourself? This signs you out."))
			return;
		const done = await optimism.change({
			label: `Removing ${p.name}`,
			patch: withPerson(p.id, { status: "removed" }),
			send: () => removeStaffMember({ data: { staffId: p.id } }),
		});
		if (done && p.id === meId) window.location.assign("/login");
	}

	const restore = (p: Person) =>
		optimism.change({
			label: `Restoring ${p.name}`,
			patch: withPerson(p.id, { status: "active" }),
			send: () => restoreStaffMember({ data: { staffId: p.id } }),
		});

	return (
		<Card title="Staff" flush>
			<AddPerson
				onAdded={async (name, made) => {
					setLink(await madeLink(name, made));
					router.invalidate();
				}}
			/>
			{link && (
				<SetupLinkPanel
					link={link}
					onDone={() => {
						setLink(null);
						router.invalidate();
					}}
				/>
			)}
			<ul>
				{access.staff.map((p) => {
					const removed = p.status === "removed";
					const lastOwner = p.role === "owner" && !removed && owners <= 1;
					return (
						<Row
							key={p.id}
							actions={
								removed ? (
									<>
										<ActionSlot />
										<ActionSlot />
										<IconAction
											icon={RotateCcw}
											label="Restore"
											onClick={() => restore(p)}
										/>
									</>
								) : (
									<>
										<IconAction
											icon={Link2}
											label="Add a device"
											onClick={() => linkFor(p)}
										/>
										<IconAction
											icon={p.role === "owner" ? ShieldCheck : Shield}
											label={
												p.role === "owner" ? "Make operator" : "Make owner"
											}
											tip={lastOwner ? "Last owner" : undefined}
											disabled={lastOwner}
											onClick={() =>
												setRole(p, p.role === "owner" ? "operator" : "owner")
											}
										/>
										<IconAction
											icon={Trash2}
											label="Remove"
											tip={lastOwner ? "Last owner" : undefined}
											disabled={lastOwner}
											onClick={() => remove(p)}
										/>
									</>
								)
							}
						>
							<div
								className={cn(
									"min-w-0 flex-1 transition-opacity",
									removed && "opacity-50",
								)}
							>
								<p className="flex items-center gap-2 font-medium">
									<span className={cn("truncate", removed && "line-through")}>
										{p.name}
									</span>
									<Badge tone={p.role === "owner" ? "info" : undefined}>
										{p.role === "owner" ? "Owner" : "Operator"}
									</Badge>
									{p.id === meId && <Badge>You</Badge>}
								</p>
								<p className="text-xs text-muted-foreground">
									{p.devices === 0
										? "No devices"
										: `${p.devices} device${p.devices === 1 ? "" : "s"}`}
								</p>
							</div>
						</Row>
					);
				})}
			</ul>
		</Card>
	);
}

function AddPerson({
	onAdded,
}: {
	onAdded: (
		name: string,
		made: { url: string; expiresAt: Date | string },
	) => Promise<void>;
}) {
	const [name, setName] = useState("");
	const [role, setRole] = useState<Role>("operator");
	const [state, setState] = useState<"idle" | "busy" | "refused">("idle");

	async function submit(e: FormEvent) {
		e.preventDefault();
		setState("busy");
		try {
			const made = await addStaffMember({ data: { name, role } });
			await onAdded(name.trim(), made);
			setName("");
			setState("idle");
		} catch (err) {
			setState("refused");
			toast.error(errorMessage(err));
		}
	}

	return (
		<form onSubmit={submit} className="flex gap-2 px-4 pb-3">
			<input
				value={name}
				onChange={(e) => {
					setName(e.target.value);
					if (state === "refused") setState("idle");
				}}
				placeholder="Name"
				aria-label="Name"
				className={cn(
					inputClass,
					state === "refused" && "border-critical-text",
				)}
			/>
			<select
				value={role}
				onChange={(e) =>
					setRole(e.target.value === "owner" ? "owner" : "operator")
				}
				aria-label="Role"
				className="h-8 rounded-lg border border-input bg-white px-2"
			>
				<option value="operator">Operator</option>
				<option value="owner">Owner</option>
			</select>
			<Button
				type="submit"
				size="sm"
				disabled={state === "busy" || name.trim() === ""}
			>
				{state === "busy" ? "Adding…" : "Add"}
			</Button>
		</form>
	);
}
