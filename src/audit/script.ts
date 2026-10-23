import { systemActor } from "#/auth/actor";
import { type AuditContext, enterContext } from "./context";

// For command-line scripts only: the rest of the script runs as
// katasync (script), so what it writes is credited to it rather than left
// unattributed. Refuses to replace an actor already set, so it can't be
// used inside a request.
export function actAsScript(script: string) {
	const context: AuditContext = {
		actor: systemActor("script"),
		operation: `script ${script}`,
	};
	enterContext(context);
}
