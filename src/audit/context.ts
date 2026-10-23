import { AsyncLocalStorage } from "node:async_hooks";
import type { Actor, Via } from "#/auth/actor";
import { AuthError } from "#/auth/sessions";

// The actor a request or job runs as, carried through its async calls. One
// store per process, even if a bundler loads this module twice.

export type AuditContext = Readonly<{
	actor: Actor;
	operation: string | null;
}>;

const OPERATION_LENGTH = 200;
const key = Symbol.for("katasync.auditContext");
const holder = globalThis as { [key]?: AsyncLocalStorage<AuditContext> };
const storage = holder[key] ?? new AsyncLocalStorage<AuditContext>();
holder[key] = storage;

export function runAs<T>(
	actor: Actor,
	operation: string | null,
	work: () => T,
): Promise<Awaited<T>> {
	const context: AuditContext = Object.freeze({
		actor,
		operation: operation?.slice(0, OPERATION_LENGTH) ?? null,
	});
	return storage.run(context, async () => await work());
}

export function enterContext(context: AuditContext) {
	if (storage.getStore())
		throw new Error("An actor is already set; use runAs inside it instead");
	storage.enterWith(
		Object.freeze({
			actor: context.actor,
			operation: context.operation?.slice(0, OPERATION_LENGTH) ?? null,
		}),
	);
}

export const currentContext = (): AuditContext | null =>
	storage.getStore() ?? null;

export function requireActor(): Actor {
	const context = storage.getStore();
	if (!context) throw new AuthError("Signed out. Reload the page to sign in.");
	return context.actor;
}

type AuditSetting = {
	kind: Actor["kind"];
	operation: string | null;
	staff_id?: string;
	staff_name?: string;
	staff_role?: string;
	via_kind?: string;
	via_id?: string;
	via_name?: string;
	system?: string;
};

export function auditSetting({ actor, operation }: AuditContext): string {
	const via = (v: Via) => ({
		via_kind: v.kind,
		via_id: v.kind === "device" ? v.passkeyId : v.grantId,
		via_name: v.name,
	});
	let setting: AuditSetting;
	switch (actor.kind) {
		case "staff":
			setting = {
				kind: "staff",
				operation,
				staff_id: actor.staffId,
				staff_name: actor.name,
				staff_role: actor.role,
				...via(actor.via),
			};
			break;
		case "legacy":
			setting = { kind: "legacy", operation, ...via(actor.via) };
			break;
		case "system":
			setting = { kind: "system", operation, system: actor.name };
			break;
	}
	return JSON.stringify(setting);
}
