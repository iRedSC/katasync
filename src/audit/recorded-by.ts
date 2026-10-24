import type { Actor } from "#/auth/actor";

export function recordedBy(actor: Actor): string {
	switch (actor.kind) {
		case "staff":
			return `staff:${actor.staffId}`;
		case "legacy":
			return actor.via.kind === "device"
				? `legacy:device:${actor.via.passkeyId}`
				: `legacy:grant:${actor.via.grantId}`;
		case "system":
			return `system:${actor.name}`;
		default: {
			const unreachable: never = actor;
			return unreachable;
		}
	}
}
