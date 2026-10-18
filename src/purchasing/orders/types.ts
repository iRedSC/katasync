import type { purchaseOrders } from "#/db/schema";
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

export type DeletedDraft = {
	id: number;
	supplierId: number;
	locationId: number;
	notes: string | null;
	createdAt: Date;
	lines: {
		productId: number;
		unit: string;
		packSize: number;
		supplierCount: number;
		minimumQuantity: number;
		quantity: number;
		unitCost: number | null;
		discounts: Discount[];
	}[];
	skippedParts: { setProductId: number; partProductId: number }[];
};
