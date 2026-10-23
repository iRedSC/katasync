import { optimistic } from "#/lib/optimism";
import type { listDevices } from "#/server/auth";

export type Access = Awaited<ReturnType<typeof listDevices>>;
export type Person = Access["staff"][number];
export type Device = Access["devices"][number];

export const accessData = optimistic<Access>("access");

export const patchAccess = (apply: (access: Access) => Access) =>
	accessData.patch("all", apply);

export const errorMessage = (err: unknown) =>
	err instanceof Error ? err.message : String(err);
