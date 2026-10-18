import { type } from "arktype";
import { shopifyQuery } from "./client";
import { money } from "./order-shapes";

const lineItem = type({
	id: "string",
	sku: "string | null",
	name: "string",
	quantity: "number.integer",
	currentQuantity: "number.integer",
	variant: type({ id: "string" }).or("null"),
	discountedUnitPriceAfterAllDiscountsSet: money,
});

const linesPage = type({
	order: {
		lineItems: {
			pageInfo: { hasNextPage: "boolean", "endCursor?": "string | null" },
			nodes: lineItem.array(),
		},
	},
});

const LINES_QUERY = `
query Lines($id: ID!, $cursor: String) {
	order(id: $id) {
		lineItems(first: 100, after: $cursor) {
			pageInfo { hasNextPage endCursor }
			nodes {
				id sku name quantity currentQuantity
				variant { id }
				discountedUnitPriceAfterAllDiscountsSet { shopMoney { amount } }
			}
		}
	}
}`;

export async function remainingLines(
	orderId: string,
	after: string | null | undefined,
) {
	const lines: (typeof lineItem.infer)[] = [];
	let cursor = after ?? null;
	while (cursor) {
		const page = linesPage.assert(
			await shopifyQuery(LINES_QUERY, { id: orderId, cursor }),
		);
		lines.push(...page.order.lineItems.nodes);
		cursor = page.order.lineItems.pageInfo.hasNextPage
			? (page.order.lineItems.pageInfo.endCursor ?? null)
			: null;
	}
	return lines;
}
