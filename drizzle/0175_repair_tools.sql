CREATE TABLE "repair_tools" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "repair_tools_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"repair_id" integer NOT NULL,
	"tool" text NOT NULL,
	"product_id" integer,
	"serial" text,
	"problem" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "repair_tools_repair_id" UNIQUE("repair_id","id"),
	CONSTRAINT "repair_tools_tool_present" CHECK (length(trim("repair_tools"."tool")) > 0)
);
--> statement-breakpoint
ALTER TABLE "repair_parts" DROP CONSTRAINT "repair_parts_one_per_product";--> statement-breakpoint
ALTER TABLE "repairs" DROP CONSTRAINT "repairs_tool_present";--> statement-breakpoint
ALTER TABLE "repairs" DROP CONSTRAINT "repairs_customer_by_kind";--> statement-breakpoint
ALTER TABLE "repair_labor" ADD COLUMN "tool_id" integer;--> statement-breakpoint
ALTER TABLE "repair_parts" ADD COLUMN "tool_id" integer;--> statement-breakpoint
ALTER TABLE "repair_tools" ADD CONSTRAINT "repair_tools_repair_id_repairs_id_fk" FOREIGN KEY ("repair_id") REFERENCES "public"."repairs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "repair_tools" ADD CONSTRAINT "repair_tools_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "repair_tools_repair_idx" ON "repair_tools" USING btree ("repair_id");--> statement-breakpoint
ALTER TABLE "repair_labor" ADD CONSTRAINT "repair_labor_tool_fk" FOREIGN KEY ("repair_id","tool_id") REFERENCES "public"."repair_tools"("repair_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "repair_parts" ADD CONSTRAINT "repair_parts_tool_fk" FOREIGN KEY ("repair_id","tool_id") REFERENCES "public"."repair_tools"("repair_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
-- Each repair had one tool: it becomes the repair's first, with the labor
-- and parts already on the repair, and the product a customer's was.
INSERT INTO "repair_tools" ("repair_id", "tool", "product_id", "serial", "problem", "created_at")
	SELECT "id", "tool", "product_id", "serial", "problem", "created_at" FROM "repairs";--> statement-breakpoint
UPDATE "repair_labor" l SET "tool_id" = t."id" FROM "repair_tools" t WHERE t."repair_id" = l."repair_id";--> statement-breakpoint
UPDATE "repair_parts" p SET "tool_id" = t."id" FROM "repair_tools" t WHERE t."repair_id" = p."repair_id";--> statement-breakpoint
UPDATE "repairs" SET "product_id" = NULL WHERE "kind" = 'customer';--> statement-breakpoint
ALTER TABLE "repairs" DROP COLUMN "tool";--> statement-breakpoint
ALTER TABLE "repairs" DROP COLUMN "serial";--> statement-breakpoint
ALTER TABLE "repairs" DROP COLUMN "problem";--> statement-breakpoint
ALTER TABLE "repair_parts" ADD CONSTRAINT "repair_parts_one_per_product" UNIQUE NULLS NOT DISTINCT("repair_id","tool_id","product_id");--> statement-breakpoint
ALTER TABLE "repairs" ADD CONSTRAINT "repairs_customer_by_kind" CHECK (case "repairs"."kind"::text
				when 'customer' then "repairs"."customer_id" is not null and "repairs"."customer_name" is not null
					and "repairs"."return_line_id" is null and "repairs"."refurb_product_id" is null
					and "repairs"."product_id" is null
					and "repairs"."status"::text <> 'refurbished'
				else "repairs"."customer_id" is null and "repairs"."customer_name" is null
					and "repairs"."customer_phone" is null and "repairs"."customer_email" is null
					and "repairs"."draft_order_id" is null and "repairs"."order_id" is null
					and "repairs"."product_id" is not null and "repairs"."status"::text <> 'picked_up'
			end);--> statement-breakpoint
GRANT SELECT ON "repair_tools" TO katasync_mcp;
