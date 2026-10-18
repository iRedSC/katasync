import { channelName, formatCount } from "#/lib/format";
import type { Item } from "./item";

// Why an item's profit isn't final yet, in words.
export function unsure(i: Item): string[] {
	const sold = channelName(i.soldOn);
	return [
		!i.costKnown &&
			(i.productId === null
				? "Not linked to a product, so it has no cost"
				: "No product cost, so its profit is too high"),
		i.feesStatus === "estimated" &&
			`Fees are an estimate until ${sold} reports them`,
		i.labelsStatus === "awaiting" &&
			`Shipped; waiting for ${sold} to bill any label`,
		i.labelsStatus === "missing" &&
			"Shipped, but no label cost from anyone, so its profit is too high",
		i.labelsStatus === "stand_in" &&
			"The label cost is an estimate until it's billed",
		i.returning > 0 &&
			`Refunded; ${formatCount(i.returning)} not back yet, so ${i.returning === 1 ? "its" : "their"} cost isn't counted until written off or 60 days pass`,
	].filter((n): n is string => typeof n === "string");
}
