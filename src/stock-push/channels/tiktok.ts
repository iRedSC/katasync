import { type } from "arktype";
import { shopCipher, tiktokApi } from "#/channels/tiktok";
import { errorText } from "#/diagnostics/runs";
import { chunks, type Found, type StockChannel } from "../channel";

// TikTok keeps stock per SKU per warehouse. katasync sets a SKU's stock in
// the one sales warehouse that holds it; a SKU split across several is left
// for a person, since katasync can't know how the split should go.

const target = type({ productId: "string", warehouseId: "string" });
type Target = typeof target.infer;

const warehousesData = type({
	warehouses: type({
		id: "string",
		type: "string",
		effect_status: "string",
	}).array(),
});

const productIdsPage = type({
	"products?": type({ id: "string" }).array(),
	"next_page_token?": "string",
});

const inventoryData = type({
	inventory: type({
		product_id: "string",
		skus: type({
			id: "string",
			"warehouse_inventory?": type({
				warehouse_id: "string",
				available_quantity: "number.integer",
			}).array(),
		}).array(),
	}).array(),
});

// One SKU's stock as a stock read sees it. Only warehouses we sell from
// count; a return warehouse isn't stock for sale.
export function tiktokStockFound(
	productId: string,
	sku: (typeof inventoryData.infer)["inventory"][number]["skus"][number],
	sales: Set<string>,
): Found<Target> {
	const held = (sku.warehouse_inventory ?? []).filter((w) =>
		sales.has(w.warehouse_id),
	);
	if (held.length === 0)
		return {
			state: "unpushable",
			reason: "TikTok shows it in no sales warehouse",
		};
	if (held.length > 1)
		return {
			state: "unpushable",
			reason: `its TikTok stock is split across ${held.length} warehouses`,
		};
	return {
		state: "ready",
		target: { productId, warehouseId: held[0].warehouse_id },
		shows: held[0].available_quantity,
	};
}

async function read() {
	const cipher = await shopCipher();
	const { warehouses } = warehousesData.assert(
		await tiktokApi("/logistics/202309/warehouses", { shop_cipher: cipher }),
	);
	const sales = new Set(
		warehouses
			.filter(
				(w) => w.type === "SALES_WAREHOUSE" && w.effect_status === "ENABLED",
			)
			.map((w) => w.id),
	);
	const productIds: string[] = [];
	let pageToken: string | undefined;
	do {
		const page = productIdsPage.assert(
			await tiktokApi(
				"/product/202309/products/search",
				{
					shop_cipher: cipher,
					page_size: "100",
					...(pageToken ? { page_token: pageToken } : {}),
				},
				{},
			),
		);
		productIds.push(...(page.products ?? []).map((p) => p.id));
		pageToken = page.next_page_token || undefined;
	} while (pageToken);

	const found = new Map<string, Found<Target>>();
	for (const ids of chunks(productIds, 100)) {
		const { inventory } = inventoryData.assert(
			await tiktokApi(
				"/product/202309/inventory/search",
				{ shop_cipher: cipher },
				{ product_ids: ids },
			),
		);
		for (const product of inventory)
			for (const sku of product.skus)
				found.set(sku.id, tiktokStockFound(product.product_id, sku, sales));
	}
	return found;
}

// One call per product, all its SKUs at once. TikTok answers for the whole
// product, so a refusal is every one of its SKUs' error.
async function write(writes: Parameters<StockChannel<Target>["write"]>[0]) {
	const cipher = await shopCipher();
	const byProduct = new Map<string, typeof writes>();
	for (const w of writes)
		byProduct.set(w.target.productId, [
			...(byProduct.get(w.target.productId) ?? []),
			w,
		]);
	const failures = new Map<string, string>();
	for (const [productId, skus] of byProduct) {
		try {
			await tiktokApi(
				`/product/202309/products/${productId}/inventory/update`,
				{ shop_cipher: cipher },
				{
					skus: skus.map((w) => ({
						id: w.externalId,
						inventory: [
							{ warehouse_id: w.target.warehouseId, quantity: w.quantity },
						],
					})),
				},
			);
		} catch (error) {
			for (const w of skus) failures.set(w.externalId, errorText(error));
		}
	}
	return failures;
}

export const tiktokStock: StockChannel<Target> = {
	name: "TikTok",
	target,
	read,
	write,
};
