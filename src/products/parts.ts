import { sql } from "drizzle-orm";
import { listings, products } from "#/db/schema";

// Whether a product is a part for a tool: Shopify files it as one ("Part",
// "Flat Box Part"), or its name leads with its part number ("[05-42S] ...").
// Its id is written out in full: in a query on products alone drizzle leaves
// it bare, which inside the subquery would mean the listing's own.
export const isPart = sql<boolean>`(${products.name} like '[%' or exists (select 1 from ${listings} l where l.product_id = ${products}.id and l.product_type ~* '(^| )part$'))`;
