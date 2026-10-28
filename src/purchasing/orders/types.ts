import type {
	purchaseOrderCharges,
	purchaseOrderLines,
	purchaseOrders,
} from "#/db/schema";
import type { Discount } from "#/purchasing/discount";

export type Status = (typeof purchaseOrders.$inferSelect)["status"];

export type AddedLine = {
	id: number;
	unit: string;
	packSize: number;
	supplierCount: number;
	minimumQuantity: number;
	quantity: number;
	unitCost: number | null;
};

// Everything a draft is, so Undo brings back the same draft. Derived from the
// tables, so a column added to a PO or its lines is in the snapshot (and its
// restore) unless it's named here as one a draft never has.
type DraftColumns = Omit<
	typeof purchaseOrders.$inferSelect,
	"status" | "sentAt" | "sentTo" | "expectedAt" | "closedAt"
>;
type DraftLineColumns = Omit<
	typeof purchaseOrderLines.$inferSelect,
	| "id"
	| "purchaseOrderId"
	| "sentQuantity"
	| "sentUnitCost"
	| "receivingNote"
	| "backOrderedAt"
>;
type DraftChargeColumns = Omit<
	typeof purchaseOrderCharges.$inferSelect,
	"id" | "purchaseOrderId"
>;

export type DeletedDraft = DraftColumns & {
	lines: (DraftLineColumns & { discounts: Discount[] })[];
	charges: DraftChargeColumns[];
	excludedCatalogIds: number[];
	skippedParts: { setProductId: number; partProductId: number }[];
};
