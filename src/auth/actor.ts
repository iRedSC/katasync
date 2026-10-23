import { AuthError } from "./sessions";

// Who is doing something: a named person, an unassigned device or app from
// before staff existed, or katasync itself. Every request and background job
// runs as one (src/audit/context.ts), and the audit log records it.

export const STAFF_ROLES = ["owner", "operator"] as const;
export type StaffRole = (typeof STAFF_ROLES)[number];

export type Via =
	| { kind: "device"; passkeyId: string; name: string }
	| { kind: "grant"; grantId: string; name: string };

export const SYSTEM_NAMES = [
	"dev-server",
	"cron",
	"webhook",
	"upload-link",
	"stock-push",
	"recovery-script",
	"sign-in",
	"oauth",
	"script",
] as const;
export type SystemName = (typeof SYSTEM_NAMES)[number];

export type Actor =
	| {
			kind: "staff";
			staffId: string;
			name: string;
			role: StaffRole;
			via: Via;
	  }
	| { kind: "legacy"; via: Via }
	| { kind: "system"; name: SystemName };

export const systemActor = (
	name: SystemName,
): Extract<Actor, { kind: "system" }> => ({
	kind: "system",
	name,
});

export class Forbidden extends AuthError {
	name = "Forbidden";
}

export function mayAdminister(actor: Actor): boolean {
	switch (actor.kind) {
		case "staff":
			return actor.role === "owner";
		case "legacy":
			return false;
		case "system":
			return actor.name === "dev-server" || actor.name === "recovery-script";
	}
}

export function describeActor(actor: Actor): string {
	switch (actor.kind) {
		case "staff":
			return actor.via.kind === "device"
				? `${actor.name} on ${actor.via.name}`
				: `${actor.via.name} for ${actor.name}`;
		case "legacy":
			return actor.via.kind === "device"
				? `Unassigned device ${actor.via.name}`
				: `${actor.via.name} (unassigned)`;
		case "system":
			return `katasync (${actor.name})`;
	}
}
