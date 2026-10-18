import { optimistic } from "#/lib/optimism";
import type { Diagnostics } from "#/server/diagnostics";

// The page's data with changes the server hasn't confirmed laid over it.
export const diagnosticsData = optimistic<Diagnostics>("diagnostics");
