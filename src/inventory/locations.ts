import { inArray } from "drizzle-orm";
import { locations } from "#/db/schema";

// Locations whose stock is ours: the warehouse and the retail store, not
// Amazon's FBA. Counting, transfers, POs, buying, and what the channels sell
// all work across these. Only the warehouse (kind "owned" alone) ships
// orders, so shipping and ship-from still check for that.
export const ourKinds = ["owned", "retail"] as const;
export type OurKind = (typeof ourKinds)[number];

export const isOurs = inArray(locations.kind, [...ourKinds]);
