import { vi } from "vitest";
import { formatMinutes } from "./labor";

// A Shopify that keeps draft orders in memory, enough for src/repairs: the
// labor product, draft orders made, changed, read, paid, and deleted.

export const LABOR = [15, 30, 45, 60, 75, 90, 105, 120].map((m) => ({
	id: `gid://shopify/ProductVariant/L${m}`,
	title: formatMinutes(m),
	price: ((m / 60) * 55).toFixed(2),
}));

type Line = {
	uuid: string;
	title: string;
	quantity: number;
	custom: boolean;
	sku: string | null;
	taxable: boolean;
	requiresShipping: boolean;
	variant: { id: string } | null;
	originalUnitPriceSet: { shopMoney: { amount: string } };
	discountedTotalSet: { shopMoney: { amount: string } };
	priceOverride: null;
	appliedDiscount: null;
	customAttributes: { key: string; value: string }[];
	weight: null;
};

export type FakeDraft = {
	id: string;
	name: string;
	status: "OPEN" | "INVOICE_SENT" | "COMPLETED";
	customerId: string | null;
	tags: string[];
	note: string;
	order: { id: string; name: string } | null;
	lines: Line[];
};

const price = (variantId: string) =>
	LABOR.find((v) => v.id === variantId)?.price ?? "10.00";

function toLine(input: Record<string, unknown>): Line {
	const variantId = input.variantId as string | undefined;
	const unit = variantId
		? price(variantId)
		: (input.originalUnitPriceWithCurrency as { amount: string }).amount;
	const quantity = input.quantity as number;
	return {
		uuid: (input.uuid as string) ?? crypto.randomUUID(),
		title: variantId ? `Item ${variantId}` : (input.title as string),
		quantity,
		custom: !variantId,
		sku: (input.sku as string) ?? null,
		taxable: (input.taxable as boolean) ?? true,
		requiresShipping: (input.requiresShipping as boolean) ?? true,
		variant: variantId ? { id: variantId } : null,
		originalUnitPriceSet: { shopMoney: { amount: unit } },
		discountedTotalSet: {
			shopMoney: { amount: (Number(unit) * quantity).toFixed(2) },
		},
		priceOverride: null,
		appliedDiscount: null,
		customAttributes:
			(input.customAttributes as Line["customAttributes"]) ?? [],
		weight: null,
	};
}

const show = (d: FakeDraft) => {
	const subtotal = d.lines.reduce(
		(n, l) => n + Number(l.discountedTotalSet.shopMoney.amount),
		0,
	);
	return {
		id: d.id,
		name: d.name,
		status: d.status,
		invoiceSentAt: null,
		order: d.order,
		subtotalPriceSet: { shopMoney: { amount: subtotal.toFixed(2) } },
		totalTaxSet: { shopMoney: { amount: "0.00" } },
		totalPriceSet: { shopMoney: { amount: subtotal.toFixed(2) } },
		lineItems: { nodes: d.lines },
	};
};

export function fakeShopify() {
	const drafts = new Map<string, FakeDraft>();
	let next = 1;
	const calls: string[] = [];
	vi.stubEnv("SHOPIFY_STORE_DOMAIN", "shop.example");
	vi.stubEnv("SHOPIFY_ADMIN_TOKEN", "token");
	vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
		const { query, variables: v } = JSON.parse(String(init.body)) as {
			query: string;
			variables: Record<string, never>;
		};
		const ok = (data: unknown) => Response.json({ data });
		if (query.includes("draftOrderCreate")) {
			calls.push("create");
			const input = v.input as Record<string, unknown>;
			const id = `gid://shopify/DraftOrder/${next}`;
			const d: FakeDraft = {
				id,
				name: `#D${next++}`,
				status: "OPEN",
				customerId:
					(input.purchasingEntity as { customerId: string } | undefined)
						?.customerId ?? null,
				tags: (input.tags as string[]) ?? [],
				note: (input.note as string) ?? "",
				order: null,
				lines: (input.lineItems as Record<string, unknown>[]).map(toLine),
			};
			drafts.set(id, d);
			return ok({ draftOrderCreate: { draftOrder: show(d), userErrors: [] } });
		}
		if (query.includes("draftOrderUpdate")) {
			calls.push("update");
			const d = drafts.get(v.id);
			if (!d || d.status === "COMPLETED")
				return ok({
					draftOrderUpdate: {
						draftOrder: null,
						userErrors: [{ field: null, message: "Draft can't change" }],
					},
				});
			const input = v.input as Record<string, unknown>;
			if (input.lineItems)
				d.lines = (input.lineItems as Record<string, unknown>[]).map(toLine);
			if (typeof input.note === "string") d.note = input.note;
			return ok({ draftOrderUpdate: { draftOrder: show(d), userErrors: [] } });
		}
		if (query.includes("draftOrderDelete")) {
			calls.push("delete");
			drafts.delete(v.id);
			return ok({ draftOrderDelete: { deletedId: v.id, userErrors: [] } });
		}
		if (query.includes("draftOrder(id")) {
			const d = drafts.get(v.id);
			return ok({ draftOrder: d ? show(d) : null });
		}
		if (query.includes("nodes(ids")) {
			return ok({
				nodes: (v.ids as string[]).map((id) => {
					const d = drafts.get(id);
					return d ? { id: d.id, status: d.status, order: d.order } : null;
				}),
			});
		}
		if (query.includes("products(")) {
			return ok({
				products: {
					nodes: [{ title: "Labor @ $55/hr", variants: { nodes: LABOR } }],
				},
			});
		}
		throw new Error(`Fake Shopify doesn't know ${query.slice(0, 60)}`);
	});
	return {
		drafts,
		calls,
		// Someone adds a line at the register.
		addAtRegister(id: string, title: string, amount: string) {
			drafts.get(id)?.lines.push(
				toLine({
					title,
					quantity: 1,
					originalUnitPriceWithCurrency: { amount },
					uuid: crypto.randomUUID(),
				}),
			);
		},
		pay(id: string, orderName = "#1234") {
			const d = drafts.get(id);
			if (!d) throw new Error(`No draft ${id}`);
			d.status = "COMPLETED";
			d.order = { id: "gid://shopify/Order/99", name: orderName };
		},
	};
}
