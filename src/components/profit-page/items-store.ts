import { optimistic } from "#/lib/optimism";
import type { Item } from "./item";

export const itemsData = optimistic<Item[]>("profit-items");
